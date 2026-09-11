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
import {
  createRunManifest,
  setRunStatus,
} from "../src/planning/run-manifest.js";
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

/** A cumulative row with every metered field explicit — for the token-unit
 * tests (#152), where cache traffic must NOT count as tokens. */
const fullRow = (
  sessionId: string, ts: string,
  t: { input: number; output: number; cacheWrite: number; cacheRead: number },
  usd: number,
): string =>
  JSON.stringify({
    ts,
    session_id: sessionId,
    phase: 15,
    kind: "issue",
    input_tokens: t.input,
    output_tokens: t.output,
    cache_write_tokens: t.cacheWrite,
    cache_read_tokens: t.cacheRead,
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
    expect(onDisk.version).toBe(2);
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

describe("token unit (#152) — input+output only, the estimator's unit", () => {
  it("charges only input+output tokens on a cache-heavy session; USD reflects everything", () => {
    // the live incident shape: 40.4M metered tokens, nearly all cache reads,
    // against a sane $13 — the old sum-of-four unit blew a 400k ceiling
    // instantly while the USD axis stayed calm
    const { ledger } = setup({
      ceilingTokens: 500_000,
      metricsLines: [
        fullRow("driver-heavy", "2026-09-01T01:00:00.000Z", {
          input: 300_000, output: 100_000,
          cacheWrite: 900_000, cacheRead: 39_100_000,
        }, 13),
      ],
    });
    const check = checkBudget(refreshSpend(ledger));
    expect(check.spentTokens).toBe(400_000); // input + output ONLY
    expect(check.spentUsd).toBeCloseTo(13, 4); // cache still priced in USD
    expect(check.verdict).toBe("proceed"); // old unit: instant stop at 40.4M
    expect(check.remainingTokens).toBe(100_000);
  });

  it("computes baselines and deltas on the same input+output unit", () => {
    const projectDir = tempDir("cairn-budget-proj-");
    const baseDir = tempDir("cairn-budget-home-");
    const metrics = budgetMetricsPath(projectDir, baseDir);
    mkdirSync(dirname(metrics), { recursive: true });
    // driving session pre-exists at run-open with cache traffic already piled up
    writeFileSync(metrics, fullRow("driver", "2026-08-31T20:00:00.000Z", {
      input: 50_000, output: 10_000, cacheWrite: 200_000, cacheRead: 5_000_000,
    }, 5));
    const ledger = openRunLedger(projectDir, {
      runId: "run-1", ceilingTokens: 500_000, startedAt: RUN_START, baseDir,
    });
    // baseline snapshotted in the new unit: 60k, not 5.26M
    expect(ledger.state.baselines.driver.tokens).toBe(60_000);

    // mid-run the driver grows modest input+output and a mountain of cache reads
    appendFileSync(metrics, fullRow("driver", "2026-09-01T02:00:00.000Z", {
      input: 70_000, output: 20_000, cacheWrite: 250_000, cacheRead: 35_000_000,
    }, 13));
    const check = checkBudget(refreshSpend(ledger));
    expect(check.spentTokens).toBe(30_000); // (70k+20k) - 60k baseline
    expect(check.spentUsd).toBeCloseTo(8, 4); // 13 - 5 — cache cost stays in USD
    expect(check.verdict).toBe("proceed");
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

describe("driving-session baseline delta (#143)", () => {
  it("counts a pre-existing session as the delta past its run-open baseline", () => {
    // driver's cumulative row predates run-open — v1 read this as ZERO all run
    const { ledger, metrics } = setup({
      ceilingTokens: 100_000,
      metricsLines: [row("driver", "2026-08-31T22:00:00.000Z", 5_000, 50)],
    });
    expect(ledger.state.baselines).toEqual({
      driver: { tokens: 5_000, usd: 50 },
    });
    // untouched since open — contributes nothing yet
    expect(checkBudget(refreshSpend(ledger)).sessionTokens).toBe(0);

    // the driver keeps working: its cumulative total grows past the baseline
    appendFileSync(metrics, row("driver", "2026-09-01T01:00:00.000Z", 5_600, 56));
    const check = checkBudget(refreshSpend(ledger));
    expect(check.sessionTokens).toBe(600); // 5600 - 5000, never the full 5600
    expect(check.spentTokens).toBe(600);
    expect(check.spentUsd).toBeCloseTo(6, 4);
  });

  it("floors the delta at 0 when the latest row shrinks below the baseline", () => {
    const { ledger, metrics } = setup({
      ceilingTokens: 100_000,
      metricsLines: [row("driver", "2026-08-31T22:00:00.000Z", 5_000, 50)],
    });
    // a truncated/rotated metrics file must never produce negative spend
    appendFileSync(metrics, row("driver", "2026-09-01T01:00:00.000Z", 4_000, 40));
    const check = checkBudget(refreshSpend(ledger));
    expect(check.sessionTokens).toBe(0);
    expect(check.spentUsd).toBe(0);
  });

  it("adds baseline deltas and full totals of run-started sessions", () => {
    const { ledger, metrics } = setup({
      ceilingTokens: 100_000,
      metricsLines: [row("driver", "2026-08-31T22:00:00.000Z", 5_000, 50)],
    });
    appendFileSync(metrics, row("driver", "2026-09-01T01:00:00.000Z", 5_600, 56));
    appendFileSync(metrics, row("s1", "2026-09-01T01:30:00.000Z", 300, 3));
    const check = checkBudget(refreshSpend(ledger));
    expect(check.sessionTokens).toBe(900); // 600 delta + 300 full
    expect(check.spentUsd).toBeCloseTo(9, 4);
  });

  it("loads a v1 ledger with empty baselines, zero agent tokens, and a note", () => {
    const { projectDir, baseDir, ledger, metrics } = setup({});
    // hand-write the pre-#143 shape over the file
    const v1 = {
      version: 1,
      run_id: "run-1",
      project: "legacy",
      opened: RUN_START,
      ceiling_tokens: 1000,
      spent_tokens: 0,
      spent_usd: 0,
      boundaries: [],
    };
    writeFileSync(ledger.path, JSON.stringify(v1, null, 2) + "\n");
    appendFileSync(metrics, row("driver", "2026-08-31T22:00:00.000Z", 5_000, 50));

    const reopened = openRunLedger(projectDir, { runId: "run-1", baseDir });
    expect(reopened.state.version).toBe(2);
    expect(reopened.state.baselines).toEqual({}); // never invented after the fact
    expect(reopened.state.agent_tokens).toBe(0);
    expect(reopened.state.opened).toBe(RUN_START);
    expect(reopened.state.ceiling_tokens).toBe(1000);

    const check = checkBudget(refreshSpend(reopened));
    expect(check.note).toMatch(/migrated from v1/);
    // no baseline for the pre-run driver — v1 behavior preserved: excluded
    expect(check.sessionTokens).toBe(0);
  });
});

describe("agent-token spend component (#143)", () => {
  it("accumulates wave agentTokens into their own component, summed into spentTokens", () => {
    const { ledger, baseDir, projectDir } = setup({
      ceilingTokens: 10_000,
      metricsLines: [row("s1", "2026-09-01T01:00:00.000Z", 300, 3)],
    });
    const first = recordBoundary(ledger, { phase: 15, wave: 1, agentTokens: 1_200 });
    expect(first.sessionTokens).toBe(300);
    expect(first.agentTokens).toBe(1_200);
    expect(first.spentTokens).toBe(1_500); // sum of the two components

    const second = recordBoundary(ledger, { phase: 15, wave: 2, agentTokens: 800 });
    expect(second.agentTokens).toBe(2_000); // accumulates across boundaries
    expect(second.spentTokens).toBe(2_300);

    const onDisk = JSON.parse(readFileSync(ledger.path, "utf8")) as BudgetLedgerState;
    expect(onDisk.boundaries[0]).toMatchObject({
      wave: 1, agent_tokens: 1_200, spent_tokens: 1_500,
    });
    expect(onDisk.boundaries[1]).toMatchObject({
      wave: 2, agent_tokens: 800, spent_tokens: 2_300,
    });

    // the component survives a reopen — a resumed run owes its agent spend
    const reopened = openRunLedger(projectDir, { runId: "run-1", baseDir });
    expect(checkBudget(refreshSpend(reopened)).agentTokens).toBe(2_000);
  });

  it("rejects a negative or fractional agentTokens with BUDGET_INVALID", () => {
    const { ledger } = setup({ ceilingTokens: 10_000 });
    for (const bad of [-1, 0.5, NaN]) {
      expect(() => recordBoundary(ledger, { phase: 15, agentTokens: bad }))
        .toThrowError(expect.objectContaining({ code: "BUDGET_INVALID" }));
    }
    // nothing leaked into the ledger from the refused boundaries
    expect(checkBudget(refreshSpend(ledger)).agentTokens).toBe(0);
  });
});

describe("live refusal — ceiling breach walks the full stop path (#143)", () => {
  it("boundary with agentTokens past a tiny ceiling → verdict stop with honest overshoot, then running → stopped", () => {
    const projectDir = tempDir("cairn-budget-proj-");
    const baseDir = tempDir("cairn-budget-home-");

    // staged manifest, advanced to running — the state a live run holds
    createRunManifest(projectDir, {
      runId: "run-live",
      phases: [{
        number: 15, name: "budget-honesty",
        estimate: { low: 500, high: 2_000, estUsd: { low: 1, high: 4 } },
      }],
      ceiling: { tokens: 1_000 },
      baseDir,
    });
    setRunStatus(projectDir, "run-live", "running", baseDir);

    // driver session already alive at open — baseline captures it
    const metrics = budgetMetricsPath(projectDir, baseDir);
    mkdirSync(dirname(metrics), { recursive: true });
    writeFileSync(metrics, row("driver", "2026-08-31T22:00:00.000Z", 2_000, 20));
    const ledger = openRunLedger(projectDir, {
      runId: "run-live", ceilingTokens: 1_000, startedAt: RUN_START, baseDir,
    });

    // the driver spends a little, and wave 1's agents report a big total
    appendFileSync(metrics, row("driver", "2026-09-01T01:00:00.000Z", 2_100, 21));
    const check = recordBoundary(ledger, {
      phase: 15, wave: 1, agentTokens: 1_500, note: "wave 1 finished",
    });

    // the refusal: real batch spend seen, honestly over, no headroom offered
    expect(check.sessionTokens).toBe(100);
    expect(check.agentTokens).toBe(1_500);
    expect(check.spentTokens).toBe(1_600);
    expect(check.verdict).toBe("stop");
    expect(check.overshoot).toEqual({ tokens: 600 });
    expect(check.innerBudgetSuggestion).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(ledger.path, "utf8")) as BudgetLedgerState;
    expect(onDisk.boundaries[0]).toMatchObject({
      verdict: "stop", agent_tokens: 1_500, spent_tokens: 1_600,
    });

    // and the executor's next move works: running → stopped, terminal after
    const stopped = setRunStatus(projectDir, "run-live", "stopped", baseDir);
    expect(stopped.status).toBe("stopped");
    expect(() => setRunStatus(projectDir, "run-live", "running", baseDir))
      .toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
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
