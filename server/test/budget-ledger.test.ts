// The budget ledger (#131): the spend accounting that decides whether the
// next phase/wave of a headless batch run starts. Synthetic metrics fixtures
// throughout — rows are CUMULATIVE per session, so totals must collapse to
// the latest row per session_id, scoped to sessions opened during the run.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  budgetLedgerPath,
  budgetMetricsPath,
  checkBudget,
  openRunLedger,
  recordBoundary,
  refreshSpend,
} from "../src/planning/budget-ledger.js";
import type { BudgetLedgerState } from "../src/planning/budget-ledger.js";
import { CairnError } from "../src/errors.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const RUN_START = "2026-09-01T00:00:00.000Z";

/** One cumulative metrics row, shaped like stop-costtracker.mjs writes. */
const row = (
  sessionId: string, ts: string, tokens: number, usd: number,
): string =>
  JSON.stringify({
    ts,
    session_id: sessionId,
    phase: 15,
    kind: "issue",
    input_tokens: tokens,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    est_cost_usd: usd,
    models: ["claude-fable-5"],
  }) + "\n";

/** Opens a ledger against a fresh injectable base dir and writes the given
 * metrics lines under it. Returns { projectDir, baseDir, ledger }. */
function setup(opts: {
  runId?: string;
  ceilingTokens?: number;
  ceilingUsd?: number;
  metricsLines?: string[];
}) {
  const projectDir = tempDir("cairn-budget-proj-");
  const baseDir = tempDir("cairn-budget-home-");
  const metrics = budgetMetricsPath(projectDir, baseDir);
  mkdirSync(dirname(metrics), { recursive: true });
  writeFileSync(metrics, (opts.metricsLines ?? []).join(""));
  const ledger = openRunLedger(projectDir, {
    runId: opts.runId ?? "run-1",
    ceilingTokens: opts.ceilingTokens,
    ceilingUsd: opts.ceilingUsd,
    startedAt: RUN_START,
    baseDir,
  });
  return { projectDir, baseDir, metrics, ledger };
}

describe("openRunLedger", () => {
  it("creates a versioned ledger file under <base>/budget/, outside the project", () => {
    const { projectDir, baseDir, ledger } = setup({ ceilingTokens: 1000 });
    expect(ledger.path).toBe(budgetLedgerPath(projectDir, "run-1", baseDir));
    expect(ledger.path.startsWith(join(baseDir, "budget"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(ledger.path, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.run_id).toBe("run-1");
    expect(onDisk.opened).toBe(RUN_START);
    expect(onDisk.ceiling_tokens).toBe(1000);
    expect(onDisk.boundaries).toEqual([]);
  });

  it("reloads an existing run, keeping opened/history and updating ceilings", () => {
    const { projectDir, baseDir, ledger } = setup({
      ceilingTokens: 1000,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 100, 1)],
    });
    recordBoundary(ledger, { phase: 15, wave: 1 });
    const reopened = openRunLedger(projectDir, {
      runId: "run-1", ceilingTokens: 2000, startedAt: "2099-01-01T00:00:00.000Z", baseDir,
    });
    expect(reopened.state.opened).toBe(RUN_START); // startedAt seeds create only
    expect(reopened.state.ceiling_tokens).toBe(2000);
    expect(reopened.state.boundaries).toHaveLength(1);
  });

  it("rejects a corrupt ledger file with BUDGET_INVALID", () => {
    const { projectDir, baseDir, ledger } = setup({});
    writeFileSync(ledger.path, "{not json");
    expect(() => openRunLedger(projectDir, { runId: "run-1", baseDir }))
      .toThrowError(expect.objectContaining({ code: "BUDGET_INVALID" }));
    expect(() => openRunLedger(projectDir, { runId: "run-1", baseDir }))
      .toThrow(CairnError);
  });
});

describe("cumulative-row collapse", () => {
  it("takes the LATEST row per session, never the sum of all rows", () => {
    const { ledger } = setup({
      ceilingTokens: 10_000,
      metricsLines: [
        // one session writing three cumulative snapshots
        row("s1", "2026-09-01T01:00:00.000Z", 100, 1),
        row("s1", "2026-09-01T02:00:00.000Z", 250, 2.5),
        row("s1", "2026-09-01T03:00:00.000Z", 400, 4),
        // and a second session with two
        row("s2", "2026-09-01T01:30:00.000Z", 50, 0.5),
        row("s2", "2026-09-01T02:30:00.000Z", 80, 0.8),
      ],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.spentTokens).toBe(480); // 400 + 80, NOT 880
    expect(check.spentUsd).toBeCloseTo(4.8, 4);
  });

  it("scopes to sessions that began after the run opened", () => {
    const { ledger } = setup({
      ceilingTokens: 10_000,
      metricsLines: [
        // pre-run session: first row before RUN_START — excluded even though
        // its latest row lands mid-run
        row("old", "2026-08-31T23:00:00.000Z", 9_000, 90),
        row("old", "2026-09-01T01:00:00.000Z", 9_500, 95),
        // in-run session
        row("s1", "2026-09-01T01:00:00.000Z", 300, 3),
      ],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.spentTokens).toBe(300);
    expect(check.spentUsd).toBeCloseTo(3, 4);
  });
});

describe("checkBudget verdicts", () => {
  it("proceeds under the ceiling, with remaining + innerBudgetSuggestion", () => {
    const { ledger } = setup({
      ceilingTokens: 1000,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 400, 4)],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.verdict).toBe("proceed");
    expect(check.spentTokens).toBe(400);
    expect(check.ceilingTokens).toBe(1000);
    expect(check.remainingTokens).toBe(600);
    expect(check.innerBudgetSuggestion).toEqual({ tokens: 600 });
    expect(check.overshoot).toBeUndefined();
  });

  it("stops AT the ceiling — spent == ceiling never starts new work", () => {
    const { ledger } = setup({
      ceilingTokens: 400,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 400, 4)],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.verdict).toBe("stop");
    expect(check.remainingTokens).toBe(0);
    expect(check.overshoot).toBeUndefined(); // at, not past — nothing overshot
    expect(check.innerBudgetSuggestion).toBeUndefined();
  });

  it("stops past the USD ceiling even when tokens have headroom", () => {
    const { ledger } = setup({
      ceilingTokens: 1_000_000,
      ceilingUsd: 5,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 400, 7.5)],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.verdict).toBe("stop");
    expect(check.overshoot).toEqual({ usd: 2.5 });
    expect(check.remainingUsd).toBe(0);
  });

  it("always proceeds with a note when no ceiling is set", () => {
    const { ledger } = setup({
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 999_999, 9999)],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.verdict).toBe("proceed");
    expect(check.note).toMatch(/no ceiling/);
    expect(check.ceilingTokens).toBeUndefined();
    expect(check.remainingTokens).toBeUndefined();
  });
});

describe("recordBoundary", () => {
  it("records overshoot when a boundary lands past the ceiling", () => {
    const { ledger } = setup({
      ceilingTokens: 1000,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 1600, 16)],
    });
    const check = recordBoundary(ledger, {
      phase: 15, wave: 2, note: "wave 2 finished",
    });
    expect(check.verdict).toBe("stop");
    expect(check.overshoot).toEqual({ tokens: 600 });

    const onDisk = JSON.parse(readFileSync(ledger.path, "utf8")) as BudgetLedgerState;
    expect(onDisk.boundaries).toHaveLength(1);
    expect(onDisk.boundaries[0]).toMatchObject({
      phase: 15,
      wave: 2,
      note: "wave 2 finished",
      spent_tokens: 1600,
      verdict: "stop",
    });
    // boundary ts comes from the metrics rows, never the wall clock
    expect(onDisk.boundaries[0].ts).toBe("2026-09-01T01:00:00.000Z");
  });

  it("appends boundary rows — history is append-only across boundaries", () => {
    const { ledger, metrics } = setup({
      ceilingTokens: 1000,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 200, 2)],
    });
    recordBoundary(ledger, { phase: 15, wave: 1 });
    const afterFirst = JSON.parse(readFileSync(ledger.path, "utf8")) as BudgetLedgerState;

    appendFileSync(metrics, row("s1", "2026-09-01T02:00:00.000Z", 700, 7));
    recordBoundary(ledger, { phase: 15, wave: 2 });
    const afterSecond = JSON.parse(readFileSync(ledger.path, "utf8")) as BudgetLedgerState;

    expect(afterSecond.boundaries).toHaveLength(2);
    // the first row survives verbatim — later boundaries never rewrite history
    expect(afterSecond.boundaries[0]).toEqual(afterFirst.boundaries[0]);
    expect(afterSecond.boundaries[1]).toMatchObject({
      wave: 2, spent_tokens: 700, verdict: "proceed",
    });
  });

  it("is deterministic given metrics content — two reads, same answer", () => {
    const { ledger } = setup({
      ceilingTokens: 1000,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 300, 3)],
    });
    const a = checkBudget(refreshSpend(ledger));
    const b = checkBudget(refreshSpend(ledger));
    expect(a).toEqual(b);
  });
});

describe("runId isolation", () => {
  it("two runs on one project never cross-contaminate", () => {
    const projectDir = tempDir("cairn-budget-proj-");
    const baseDir = tempDir("cairn-budget-home-");
    const metrics = budgetMetricsPath(projectDir, baseDir);
    mkdirSync(dirname(metrics), { recursive: true });
    // run A's sessions land before run B opens
    writeFileSync(metrics, row("a1", "2026-09-01T01:00:00.000Z", 900, 9));

    const runA = openRunLedger(projectDir, {
      runId: "run-a", ceilingTokens: 1000, startedAt: RUN_START, baseDir,
    });
    const runB = openRunLedger(projectDir, {
      runId: "run-b", ceilingTokens: 500, startedAt: "2026-09-01T02:00:00.000Z", baseDir,
    });
    expect(runA.path).not.toBe(runB.path);

    recordBoundary(runA, { phase: 15, wave: 1 });
    const checkB = recordBoundary(runB, { phase: 16, wave: 1 });

    // run B opened after run A's sessions began — it owes none of that spend
    expect(checkB.spentTokens).toBe(0);
    expect(checkB.verdict).toBe("proceed");
    const bDisk = JSON.parse(readFileSync(runB.path, "utf8")) as BudgetLedgerState;
    const aDisk = JSON.parse(readFileSync(runA.path, "utf8")) as BudgetLedgerState;
    expect(bDisk.boundaries).toHaveLength(1);
    expect(aDisk.boundaries).toHaveLength(1);
    expect(aDisk.boundaries[0].spent_tokens).toBe(900);
    expect(aDisk.ceiling_tokens).toBe(1000);
    expect(bDisk.ceiling_tokens).toBe(500);
  });

  it("refuses a sanitized-filename collision between distinct runIds", () => {
    const projectDir = tempDir("cairn-budget-proj-");
    const baseDir = tempDir("cairn-budget-home-");
    openRunLedger(projectDir, { runId: "run/x", startedAt: RUN_START, baseDir });
    expect(() =>
      openRunLedger(projectDir, { runId: "run:x", startedAt: RUN_START, baseDir }),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_INVALID" }));
  });
});
