import { describe, it, expect, beforeEach } from "vitest";
import {
  appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync,
} from "node:fs";
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

// Backends that DO persist structured estimates (2 of 9) -- native field, no
// prose line to scrape. The provenance tally must tell the two apart.
const fieldIssueReader = (
  fields: Record<string, { points?: number; minutes?: number }>,
): IssueReader => ({
  async getIssue(id: string): Promise<Issue> {
    const estimate = fields[id];
    if (estimate === undefined) throw new Error(`no such issue ${id}`);
    return {
      id, title: id, body: "no estimate line here", estimate,
      state: "open", category: "open", labels: [],
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
    expect(est.basis).toEqual({
      historyPhases: 0, pointsTotal: null, minutesTotal: null, issueCount: 3,
      perIssuePairs: 0, perMinutePairs: 0,
      estimateSources: {
        points: { field: 0, body: 0 }, minutes: { field: 0, body: 0 },
      },
    });
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
    // per-point:  150k / 4 pts = 37.5k; target 9 pts -> 253_125..421_875
    // per-minute: 150k / 180 min = 833.33; target 360 min -> 225_000..375_000
    // per-issue:  168_750..281_250; envelope union takes the wider bounds
    expect(est.range).toEqual({ low: 168_750, high: 421_875 });
    expect(est.basis.pointsTotal).toBe(9);
    expect(est.notes.join(" ")).toContain("tokens-per-point");
    // #230: the hours half of the same body line no longer hits the floor --
    // GH-3 (~2h) + GH-5 (~4h) = 360 minutes, GH-4 carries no hours.
    expect(est.basis.minutesTotal).toBe(360);
    expect(est.basis.perMinutePairs).toBe(1);
    expect(est.basis.estimateSources).toEqual({
      points: { field: 0, body: 3 }, minutes: { field: 0, body: 2 },
    });
    expect(est.notes.join(" ")).toContain("tokens-per-minute");
    expect(est.notes.join(" "))
      .toContain("1 of 3 issues carry no hours estimate");
  });

  it("#230 regression: the scraped hours move the envelope, they are not decoration", async () => {
    // History burned 150k over 2 points / 120 minutes. The target claims the
    // same 3 points but TEN TIMES the hours -- if the minutes signal were
    // still being dropped, the range would be identical to the points-only
    // one (168_750..281_250) and the size difference would be invisible.
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const tracker = fakeIssueReader({
      "GH-1": "Estimate: 1 points / ~1h.\n",
      "GH-2": "Estimate: 1 points / ~1h.\n",
      "GH-3": "Estimate: 1 points / ~10h.\n",
      "GH-4": "Estimate: 1 points / ~10h.\n",
      "GH-5": "Estimate: 1 points / ~10h.\n",
    });
    const est = await estimatePhaseTokens(dir, 2, { metricsFile, tracker });
    // per-minute: 150k / 120 min = 1250/min; target 1800 min -> 2_250_000,
    // thin cushion 0.75/1.25 -> 1_687_500..2_812_500. The union widens to it.
    expect(est.basis.minutesTotal).toBe(1800);
    expect(est.range).toEqual({ low: 168_750, high: 2_812_500 });
    expect(est.basis.perMinutePairs).toBe(1);
    expect(est.notes.join(" "))
      .toContain("minutes corpus: 2 from body-line scrape");
  });

  it("native minutes field is preferred over the prose line and says so", async () => {
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const tracker = fieldIssueReader({
      "GH-1": { points: 2, minutes: 180 },
      "GH-2": { points: 2, minutes: 180 },
      "GH-3": { points: 3, minutes: 120 },
      "GH-4": { points: 3, minutes: 120 },
      "GH-5": { points: 3, minutes: 120 },
    });
    const est = await estimatePhaseTokens(dir, 2, { metricsFile, tracker });
    expect(est.basis.pointsTotal).toBe(9);
    expect(est.basis.minutesTotal).toBe(360);
    expect(est.basis.estimateSources).toEqual({
      points: { field: 3, body: 0 }, minutes: { field: 3, body: 0 },
    });
    // per-point 37.5k x 9 -> 253_125..421_875; per-minute 416.67 x 360 ->
    // 112_500..187_500; per-issue 168_750..281_250. Union spans all three.
    expect(est.range).toEqual({ low: 112_500, high: 421_875 });
    expect(est.notes.join(" ")).toContain("minutes corpus: 2 from tracker field");
    expect(est.notes.join(" ")).not.toContain("MIXED");
  });

  it("mixed provenance is reported, never pooled silently", async () => {
    // One native field, one scraped prose line, one issue with no hours at
    // all -- the exact shape that would quietly fit a curve to a parser bug.
    const mixed: IssueReader = {
      async getIssue(id: string): Promise<Issue> {
        const shell = {
          id, title: id, state: "open" as const, category: "open" as const,
          labels: [], updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${id}`,
        };
        if (id === "GH-3") {
          return { ...shell, body: "native", estimate: { points: 3, minutes: 120 } };
        }
        if (id === "GH-4") return { ...shell, body: "Estimate: 3 points / ~1.5h.\n" };
        if (id === "GH-5") return { ...shell, body: "Estimate: 3 points.\n" };
        throw new Error(`no such issue ${id}`);
      },
    };
    const est = await estimatePhaseTokens(dir, 2, { metricsFile, tracker: mixed });
    expect(est.basis.pointsTotal).toBe(9);
    // 120 native + 1.5h scraped as 90 -- decimals convert, hours become minutes
    expect(est.basis.minutesTotal).toBe(210);
    expect(est.basis.estimateSources).toEqual({
      points: { field: 1, body: 2 }, minutes: { field: 1, body: 1 },
    });
    const notes = est.notes.join(" ");
    expect(notes).toContain("minutesTotal provenance: 1 from tracker field, 1 from body-line scrape");
    expect(notes).toContain("MIXED provenance");
    expect(notes).toContain("1 of 3 issues carry no hours estimate");
  });

  it("points without hours: minutes degrade on their own axis, with a note", async () => {
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const tracker = fakeIssueReader({
      "GH-1": "Estimate: 2 points.\n",
      "GH-2": "Estimate: 2 points.\n",
      "GH-3": "Estimate: 3 points.\n",
      "GH-4": "Estimate: 3 points.\n",
      "GH-5": "Estimate: 3 points.\n",
    });
    const est = await estimatePhaseTokens(dir, 2, { metricsFile, tracker });
    expect(est.basis.pointsTotal).toBe(9);
    expect(est.basis.minutesTotal).toBeNull();
    expect(est.basis.perMinutePairs).toBe(0);
    expect(est.notes.join(" "))
      .toContain("no issue in this phase carries an hours estimate");
    expect(est.notes.join(" ")).not.toContain("tokens-per-minute");
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

  // Move a scaffolded live phase into milestones/v1/<dir> the same way
  // milestoneComplete does -- the dir moves wholesale, PLAN.md and all.
  function archivePhase(phaseDir: string): void {
    const msDir = join(dir, ".cairn", "plans", "milestones", "v1");
    mkdirSync(msDir, { recursive: true });
    renameSync(join(dir, ".cairn", "plans", "phases", phaseDir),
      join(msDir, phaseDir));
  }

  it("archived plans feed per-issue grain: rehearsal shape narrows visibly vs the whole-phase fallback", async () => {
    // Rehearsal shape (#144): history phase totals differ wildly because the
    // phases differ in SIZE, while per-issue rates stay consistent. The old
    // code never found archived PLAN.md issue lists, fell back to whole-phase
    // totals, and staged the same enormous range for every target.
    scaffoldPhase(dir, 14, "alpha");
    writePlanIssues(dir, "14-alpha", ["GH-11", "GH-12"]); // 2 issues
    archivePhase("14-alpha");
    scaffoldPhase(dir, 15, "beta");
    writePlanIssues(dir, "15-beta",
      ["GH-13", "GH-14", "GH-15", "GH-16", "GH-17", "GH-18", "GH-19", "GH-20"]); // 8 issues
    archivePhase("15-beta");
    // 160k over 2 issues (80k/issue); 720k over 8 issues (90k/issue)
    appendFileSync(metricsFile, row("s14", 14, 100_000, 60_000, 32));
    appendFileSync(metricsFile, row("s15", 15, 600_000, 120_000, 144));
    // target: 4 issues, live
    scaffoldPhase(dir, 16, "gamma");
    writePlanIssues(dir, "16-gamma", ["GH-21", "GH-22", "GH-23", "GH-24"]);

    const est = await estimatePhaseTokens(dir, 16, { metricsFile });
    expect(est.confidence).toBe("calibrated");
    // per-issue grain recovered from the ARCHIVED plans: 80k..90k per issue
    // x 4 issues, thin cushion 0.75/1.25 (only 2 pairs)
    expect(est.range).toEqual({ low: 240_000, high: 450_000 });
    expect(est.basis.perIssuePairs).toBe(2);
    expect(est.notes.join(" ")).toContain("(14, 15)");
    // the old whole-phase fallback spanned raw totals: 120k..900k -- the new
    // range must be visibly narrower (here: 210k wide vs 780k wide)
    const oldFallback = { low: 160_000 * 0.75, high: 720_000 * 1.25 };
    expect(est.range.high - est.range.low)
      .toBeLessThan((oldFallback.high - oldFallback.low) / 3);
    expect(est.notes.join(" ")).not.toContain("no per-issue grain");
  });

  it("cushions tighten to -15%/+15% once three per-issue pairs exist", async () => {
    // phase 1 (beforeEach): 2 issues, 150k -> 75k/issue
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    // phase 3: 3 issues, 240k -> 80k/issue
    scaffoldPhase(dir, 3, "more");
    writePlanIssues(dir, "03-more", ["GH-6", "GH-7", "GH-8"]);
    writeFileSync(join(dir, ".cairn", "plans", "phases", "03-more", "VERIFICATION.md"), "passed\n");
    appendFileSync(metricsFile, row("s3", 3, 200_000, 40_000, 48));
    // phase 4: 2 issues, 180k -> 90k/issue
    scaffoldPhase(dir, 4, "even");
    writePlanIssues(dir, "04-even", ["GH-9", "GH-10"]);
    writeFileSync(join(dir, ".cairn", "plans", "phases", "04-even", "VERIFICATION.md"), "passed\n");
    appendFileSync(metricsFile, row("s4", 4, 150_000, 30_000, 36));

    const est = await estimatePhaseTokens(dir, 2, { metricsFile }); // 3 issues
    // 75k..90k per issue x 3 issues, cushion 0.85/1.15 (3 pairs)
    expect(est.range).toEqual({ low: 191_250, high: 310_500 });
    expect(est.basis.perIssuePairs).toBe(3);
    expect(est.notes.join(" ")).toContain("-15%/+15%");
  });

  it("cushions floor at -10%/+10% with six per-issue pairs", async () => {
    for (let p = 3; p <= 8; p++) {
      const phaseDir = `0${p}-h${p}`;
      scaffoldPhase(dir, p, `h${p}`);
      writePlanIssues(dir, phaseDir, [`GH-${p}a`, `GH-${p}b`]); // 2 issues each
      writeFileSync(join(dir, ".cairn", "plans", "phases", phaseDir, "VERIFICATION.md"), "passed\n");
      appendFileSync(metricsFile, row(`s${p}`, p, 80_000, 20_000, 20)); // 50k/issue
    }
    const est = await estimatePhaseTokens(dir, 2, { metricsFile }); // 3 issues
    // 50k per issue x 3 issues, floor cushion 0.90/1.10 (6 pairs)
    expect(est.range).toEqual({ low: 135_000, high: 165_000 });
    expect(est.basis.perIssuePairs).toBe(6);
    expect(est.notes.join(" ")).toContain("-10%/+10%");
  });

  it("deterministic: same inputs, byte-identical result", async () => {
    appendFileSync(metricsFile, row("s1", 1, 100_000, 50_000, 30));
    const a = await estimatePhaseTokens(dir, 2, { metricsFile });
    const b = await estimatePhaseTokens(dir, 2, { metricsFile });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
