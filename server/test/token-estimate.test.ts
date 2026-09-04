import { describe, it, expect, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldPhase, scaffoldProject, writePlanIssues,
} from "../src/planning/artifacts.js";
import {
  DEFAULT_TOKENS_PER_ISSUE, DEFAULT_USD_PER_MTOK, estimatePhaseTokens,
} from "../src/planning/token-estimate.js";
import type { IssueReader } from "../src/planning/token-estimate.js";
import type { Issue } from "../src/tracker/types.js";
import { CairnError } from "../src/errors.js";

// Synthetic metrics rows -- same shape stop-costtracker.mjs appends. Rows are
// CUMULATIVE per session; the estimator must take the latest per session_id.
function row(sessionId: string, phase: number, input: number, output: number,
  usd: number): string {
  return JSON.stringify({
    ts: "2026-01-01T00:00:00.000Z", session_id: sessionId, phase,
    input_tokens: input, output_tokens: output,
    cache_write_tokens: 0, cache_read_tokens: 0,
    est_cost_usd: usd, models: ["claude-fable-5"],
  }) + "\n";
}

const fakeIssueReader = (bodies: Record<string, string>): IssueReader => ({
  async getIssue(id: string): Promise<Issue> {
    const body = bodies[id];
    if (body === undefined) throw new Error(`no such issue ${id}`);
    return {
      id, title: id, body, state: "open", category: "open", labels: [],
      updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${id}`,
    };
  },
});

describe("estimatePhaseTokens", () => {
  let dir: string;
  let metricsFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-te-"));
    metricsFile = join(dir, "metrics.jsonl");
    scaffoldProject(dir, "proj");
    // phase 1: completed history (verified), 2 issues
    scaffoldPhase(dir, 1, "core");
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2"]);
    writeFileSync(join(dir, ".cairn", "plans", "phases", "01-core", "VERIFICATION.md"), "passed\n");
    // phase 2: the target, 3 issues
    scaffoldPhase(dir, 2, "next");
    writePlanIssues(dir, "02-next", ["GH-3", "GH-4", "GH-5"]);
  });

  it("no history: published wide default, confidence 'wide', honest note", async () => {
    // metricsFile deliberately absent -- nothing has ever run here
    const est = await estimatePhaseTokens(dir, 2, { metricsFile });
    expect(est.phase).toBe(2);
    expect(est.unit).toBe("tokens");
    expect(est.confidence).toBe("wide");
    expect(est.range).toEqual({
      low: DEFAULT_TOKENS_PER_ISSUE.low * 3,
      high: DEFAULT_TOKENS_PER_ISSUE.high * 3,
    });
    expect(est.estUsd.low).toBeCloseTo(
      (est.range.low / 1e6) * DEFAULT_USD_PER_MTOK.low, 2);
    expect(est.estUsd.high).toBeCloseTo(
      (est.range.high / 1e6) * DEFAULT_USD_PER_MTOK.high, 2);
    expect(est.basis).toEqual({ historyPhases: 0, pointsTotal: null, issueCount: 3 });
    expect(est.notes.join(" ")).toContain("wide default");
  });

  it("calibrated: tokens-per-issue from a completed phase scales by target issue count", async () => {
    // phase 1 spent 150k counted tokens over 2 issues -> 75k per issue
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const est = await estimatePhaseTokens(dir, 2, { metricsFile });
    expect(est.confidence).toBe("calibrated");
    // 75k/issue x 3 issues, cushioned 0.75/1.25
    expect(est.range).toEqual({ low: 168_750, high: 281_250 });
    // usd rate from history: 30 / 150k tokens
    expect(est.estUsd.low).toBeCloseTo(33.75, 2);
    expect(est.estUsd.high).toBeCloseTo(56.25, 2);
    expect(est.basis.historyPhases).toBe(1);
    expect(est.basis.issueCount).toBe(3);
    expect(est.notes.join(" ")).toContain("tokens-per-issue");
  });

  it("cumulative rows: two rows for one session collapse to the latest, never sum", async () => {
    appendFileSync(metricsFile, row("s1", 1, 10_000, 5_000, 3));
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const est = await estimatePhaseTokens(dir, 2, { metricsFile });
    // latest row wins: 150k tokens, not 165k -- identical to the single-row case
    expect(est.range).toEqual({ low: 168_750, high: 281_250 });
    expect(est.basis.historyPhases).toBe(1);
  });

  it("points: native/body-line estimates add a tokens-per-point scaler (envelope union)", async () => {
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const tracker = fakeIssueReader({
      "GH-1": "history task\n\nEstimate: 2 points.\n",
      "GH-2": "history task\n\nEstimate: 2 points / ~3h.\n",
      "GH-3": "target task\n\nEstimate: 3 points / ~2h.\n",
      "GH-4": "target task\n\nEstimate: 3 points.\n",
      "GH-5": "target task\n\nEstimate: 3 points / ~4h.\n",
    });
    const est = await estimatePhaseTokens(dir, 2, { metricsFile, tracker });
    // per-point: 150k / 4 pts = 37.5k; target 9 pts -> 253_125..421_875
    // per-issue: 168_750..281_250; envelope union takes the wider bounds
    expect(est.range).toEqual({ low: 168_750, high: 421_875 });
    expect(est.basis.pointsTotal).toBe(9);
    expect(est.notes.join(" ")).toContain("tokens-per-point");
  });

  it("in-flight phases (live dir, no VERIFICATION.md) are excluded from calibration", async () => {
    // phase 2 has metrics but is the target; phase 3 is live and unverified
    scaffoldPhase(dir, 3, "wip");
    writePlanIssues(dir, "03-wip", ["GH-9"]);
    appendFileSync(metricsFile, row("s2", 3, 500_000, 500_000, 100));
    const est = await estimatePhaseTokens(dir, 2, { metricsFile });
    expect(est.confidence).toBe("wide");
    expect(est.basis.historyPhases).toBe(0);
    expect(est.notes.join(" ")).toContain("in flight");
  });

  it("decimal phase numbers are accepted", async () => {
    scaffoldPhase(dir, 1.5, "half");
    writePlanIssues(dir, "01.5-half", ["GH-7"]);
    const est = await estimatePhaseTokens(dir, 1.5, { metricsFile });
    expect(est.phase).toBe(1.5);
    expect(est.basis.issueCount).toBe(1);
    expect(est.range.low).toBe(DEFAULT_TOKENS_PER_ISSUE.low);
  });

  it("unknown phase is NOT_FOUND", async () => {
    await expect(estimatePhaseTokens(dir, 42, { metricsFile }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(estimatePhaseTokens(dir, 42, { metricsFile }))
      .rejects.toBeInstanceOf(CairnError);
  });

  it("deterministic: same inputs, byte-identical result", async () => {
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const a = await estimatePhaseTokens(dir, 2, { metricsFile });
    const b = await estimatePhaseTokens(dir, 2, { metricsFile });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
