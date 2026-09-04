/**
 * Purpose: the spend ledger for headless batch runs (#131) — the OUTER,
 *   cross-phase budget ceiling. At every phase/wave boundary the executor
 *   re-reads actual spend from the metrics jsonl the Stop hook writes and
 *   asks checkBudget() whether the NEXT unit of work may start. Verdict is
 *   "stop" the moment spent >= ceiling: no new phase/wave ever starts past
 *   the ceiling, in-flight work finishes — the documented guarantee is
 *   bounded overshoot <= one wave.
 *
 *   Metrics rows are CUMULATIVE per session: correct totals take the LATEST
 *   row per session_id (never the sum of all rows), scoped to sessions that
 *   began after the run opened. Spend numbers are approximate list-price
 *   estimates, same caveat as cost-report.mjs.
 *
 *   The Claude Code Workflow primitive exposes its own budget global in
 *   workflow scripts (budget.total / budget.spent() / budget.remaining();
 *   over-budget agent() calls THROW). That is the INNER, in-run ceiling —
 *   the executor passes checkBudget().innerBudgetSuggestion down as the
 *   invoking run's budget (#133 wires it); this ledger stays the outer
 *   authority across phases.
 * Author(s): John Reed
 */

// Imports
import { z } from "zod";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";

// Constants

/** Tokens in a metrics row that count toward the token ceiling — everything
 * the API meters (cache reads are cheap but they are still tokens; the USD
 * ceiling is the one that prices tiers honestly). */
const TOKEN_FIELDS = [
  "input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens",
] as const;

// Paths

/** Same per-machine hashing scheme as continuity.ts's pathHash / indexDbPath. */
function pathHash(projectDir: string): { base: string; hash: string } {
  const abs = resolve(projectDir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return { base: basename(abs), hash };
}

/** Filename-safe runId — anything exotic collapses to '-'; the raw run_id
 * stays inside the file and is verified on load, so a collision here can't
 * silently merge two runs. */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** ~/.cairn/budget/<project>-<hash>-<runId>.json — one ledger file per run,
 * outside the repo (metrics/handoff convention). baseDir injectable for tests. */
export function budgetLedgerPath(
  projectDir: string, runId: string, baseDir: string = join(homedir(), ".cairn"),
): string {
  const { base, hash } = pathHash(projectDir);
  return join(baseDir, "budget", `${base}-${hash}-${safeRunId(runId)}.json`);
}

/** The metrics jsonl the Stop hook writes — same path scheme as
 * hooks/scripts/lib.mjs's metricsPath, with the base dir injectable. */
export function budgetMetricsPath(
  projectDir: string, baseDir: string = join(homedir(), ".cairn"),
): string {
  const { base, hash } = pathHash(projectDir);
  return join(baseDir, "metrics", `${base}-${hash}.jsonl`);
}

// Schema — versioned state file, same z.literal(1) + safeParse precedent as
// continuity.ts's Handoff.

export interface BudgetBoundary {
  ts: string; // from metrics rows (latest in-scope row), never Date.now
  phase: number | string;
  wave?: number | string;
  note?: string;
  sessions: number;
  spent_tokens: number;
  spent_usd: number;
  verdict: "proceed" | "stop";
}

export interface BudgetLedgerState {
  version: 1;
  run_id: string;
  project: string;
  opened: string; // run start ts — sessions that began before it don't count
  ceiling_tokens?: number;
  ceiling_usd?: number;
  spent_tokens: number;
  spent_usd: number;
  boundaries: BudgetBoundary[]; // append-only history, LEDGER.md's spirit
}

const BudgetBoundarySchema: z.ZodType<BudgetBoundary> = z.object({
  ts: z.string(),
  phase: z.union([z.number(), z.string()]),
  wave: z.union([z.number(), z.string()]).optional(),
  note: z.string().optional(),
  sessions: z.number(),
  spent_tokens: z.number(),
  spent_usd: z.number(),
  verdict: z.enum(["proceed", "stop"]),
});

export const BudgetLedgerSchema: z.ZodType<BudgetLedgerState> = z.object({
  version: z.literal(1),
  run_id: z.string(),
  project: z.string(),
  opened: z.string(),
  ceiling_tokens: z.number().optional(),
  ceiling_usd: z.number().optional(),
  spent_tokens: z.number(),
  spent_usd: z.number(),
  boundaries: z.array(BudgetBoundarySchema),
});

/** Open handle: the ledger state plus the resolved file paths it lives at. */
export interface RunLedger {
  path: string;
  metricsPath: string;
  state: BudgetLedgerState;
}

export interface BudgetCheck {
  runId: string;
  spentTokens: number;
  spentUsd: number;
  ceilingTokens?: number;
  ceilingUsd?: number;
  remainingTokens?: number;
  remainingUsd?: number;
  verdict: "proceed" | "stop";
  /** Present when spent EXCEEDS a ceiling — the honest overshoot record.
   * Bounded <= one wave because no new work starts on "stop". */
  overshoot?: { tokens?: number; usd?: number };
  /** What the executor passes down as the Workflow in-run budget (the inner
   * ceiling, #133) — the remaining headroom for the next wave. */
  innerBudgetSuggestion?: { tokens?: number; usd?: number };
  note?: string;
}

// Internals

const round4 = (n: number): number => Number(n.toFixed(4));

/** Reads and validates the ledger file at `path`; null when absent. */
function readLedgerFile(path: string): BudgetLedgerState | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("BUDGET_INVALID",
      `budget ledger at ${path} is not valid JSON: ${e}`,
      "inspect or discard ~/.cairn/budget/…");
  }
  const result = BudgetLedgerSchema.safeParse(parsed);
  if (!result.success) {
    throw new CairnError("BUDGET_INVALID",
      `budget ledger at ${path} failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "inspect or discard ~/.cairn/budget/…");
  }
  return result.data;
}

/** Atomic write — tmp then rename, same as continuity's handoff writer. */
function writeLedgerFile(path: string, state: BudgetLedgerState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Actual spend since the run opened: collapse the metrics jsonl to the
 * LATEST row per session_id (rows are cumulative — summing every row would
 * multiply-count), keeping only sessions whose FIRST row landed at or after
 * the run's `opened` ts. Deterministic given file content; a missing or
 * corrupt-lined file just contributes nothing.
 */
function measureSpend(metricsPath: string, openedTs: string): {
  tokens: number; usd: number; sessions: number; latestTs?: string;
} {
  const opened = new Date(openedTs).getTime();
  const firstTs = new Map<string, number>();
  const latest = new Map<string, Record<string, unknown>>();
  let raw: string;
  try {
    raw = readFileSync(metricsPath, "utf8");
  } catch {
    return { tokens: 0, usd: 0, sessions: 0 };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // skip corrupt line, same posture as cost-report
    }
    const sid = row.session_id;
    if (typeof sid !== "string") continue;
    if (!firstTs.has(sid)) {
      firstTs.set(sid, new Date(String(row.ts ?? "")).getTime());
    }
    latest.set(sid, row); // later lines win — append order
  }

  let tokens = 0;
  let usd = 0;
  let sessions = 0;
  let latestTs: string | undefined;
  for (const [sid, row] of latest) {
    const began = firstTs.get(sid) ?? NaN;
    if (!(began >= opened)) continue; // pre-run session — not this run's spend
    sessions += 1;
    for (const f of TOKEN_FIELDS) tokens += Number(row[f] ?? 0) || 0;
    usd += Number(row.est_cost_usd ?? 0) || 0;
    const ts = String(row.ts ?? "");
    if (ts && (!latestTs || ts > latestTs)) latestTs = ts;
  }
  return { tokens, usd: round4(usd), sessions, latestTs };
}

// API

/**
 * Creates or loads the run's ledger file under <baseDir>/budget/. Passing
 * ceilings on an existing run updates them (a re-staged run may tighten or
 * loosen the cap); everything else about an existing ledger — opened ts,
 * spend, boundary history — is preserved. `startedAt` seeds `opened` on
 * first create only, so tests and resumed runs stay deterministic.
 *
 * :param projectDir: the project the metrics roll up under
 * :returns RunLedger handle for recordBoundary / checkBudget
 */
export function openRunLedger(
  projectDir: string,
  opts: {
    runId: string;
    ceilingTokens?: number;
    ceilingUsd?: number;
    startedAt?: string;
    baseDir?: string;
  },
): RunLedger {
  if (!opts.runId || !opts.runId.trim()) {
    throw new CairnError("BUDGET_INVALID", "runId must be a non-empty string");
  }
  const baseDir = opts.baseDir ?? join(homedir(), ".cairn");
  const path = budgetLedgerPath(projectDir, opts.runId, baseDir);
  const metricsPath = budgetMetricsPath(projectDir, baseDir);

  const existing = readLedgerFile(path);
  if (existing && existing.run_id !== opts.runId) {
    // two distinct runIds collapsed to the same sanitized filename
    throw new CairnError("BUDGET_INVALID",
      `ledger at ${path} belongs to run '${existing.run_id}', not '${opts.runId}'`,
      "pick a runId that differs in more than punctuation");
  }

  const state: BudgetLedgerState = existing ?? {
    version: 1,
    run_id: opts.runId,
    project: basename(resolve(projectDir)),
    opened: opts.startedAt ?? new Date().toISOString(),
    spent_tokens: 0,
    spent_usd: 0,
    boundaries: [],
  };
  if (opts.ceilingTokens !== undefined) state.ceiling_tokens = opts.ceilingTokens;
  if (opts.ceilingUsd !== undefined) state.ceiling_usd = opts.ceilingUsd;

  writeLedgerFile(path, state);
  return { path, metricsPath, state };
}

/**
 * Refreshes the ledger's spent totals from the metrics file, in memory only
 * (no boundary row, no write) — status displays poll through this without
 * growing the history.
 */
export function refreshSpend(ledger: RunLedger): RunLedger {
  const spend = measureSpend(ledger.metricsPath, ledger.state.opened);
  ledger.state.spent_tokens = spend.tokens;
  ledger.state.spent_usd = spend.usd;
  return ledger;
}

/**
 * A phase/wave boundary: re-read actual spend, update the totals, append one
 * boundary row (append-only — history is never rewritten), persist, and
 * return the verdict. This is THE decision point of a headless run: the
 * caller never starts new work on "stop".
 */
export function recordBoundary(
  ledger: RunLedger,
  b: { phase: number | string; wave?: number | string; note?: string },
): BudgetCheck {
  const spend = measureSpend(ledger.metricsPath, ledger.state.opened);
  ledger.state.spent_tokens = spend.tokens;
  ledger.state.spent_usd = spend.usd;

  const check = checkBudget(ledger);
  const boundary: BudgetBoundary = {
    // timestamp comes from the rows (latest in-scope), falling back to the
    // run's opened ts — decision math never touches the wall clock.
    ts: spend.latestTs ?? ledger.state.opened,
    phase: b.phase,
    ...(b.wave !== undefined ? { wave: b.wave } : {}),
    ...(b.note !== undefined ? { note: b.note } : {}),
    sessions: spend.sessions,
    spent_tokens: spend.tokens,
    spent_usd: spend.usd,
    verdict: check.verdict,
  };
  ledger.state.boundaries.push(boundary);
  writeLedgerFile(ledger.path, ledger.state);
  return check;
}

/**
 * The proceed/stop verdict against the run's ceilings. Pure over the ledger
 * state — deterministic, no clock, no I/O. "stop" the moment spent >= EITHER
 * ceiling; overshoot reported per-axis when spent exceeds one. No ceilings
 * set → always "proceed", with a note saying the run is uncapped.
 */
export function checkBudget(ledger: RunLedger): BudgetCheck {
  const s = ledger.state;
  const out: BudgetCheck = {
    runId: s.run_id,
    spentTokens: s.spent_tokens,
    spentUsd: s.spent_usd,
    verdict: "proceed",
  };

  if (s.ceiling_tokens === undefined && s.ceiling_usd === undefined) {
    out.note = "no ceiling set — budget check always proceeds";
    return out;
  }

  const overshoot: { tokens?: number; usd?: number } = {};
  const suggestion: { tokens?: number; usd?: number } = {};

  if (s.ceiling_tokens !== undefined) {
    out.ceilingTokens = s.ceiling_tokens;
    out.remainingTokens = Math.max(0, s.ceiling_tokens - s.spent_tokens);
    suggestion.tokens = out.remainingTokens;
    if (s.spent_tokens >= s.ceiling_tokens) out.verdict = "stop";
    if (s.spent_tokens > s.ceiling_tokens) {
      overshoot.tokens = s.spent_tokens - s.ceiling_tokens;
    }
  }
  if (s.ceiling_usd !== undefined) {
    out.ceilingUsd = s.ceiling_usd;
    out.remainingUsd = round4(Math.max(0, s.ceiling_usd - s.spent_usd));
    suggestion.usd = out.remainingUsd;
    if (s.spent_usd >= s.ceiling_usd) out.verdict = "stop";
    if (s.spent_usd > s.ceiling_usd) {
      overshoot.usd = round4(s.spent_usd - s.ceiling_usd);
    }
  }

  if (Object.keys(overshoot).length) out.overshoot = overshoot;
  // headroom only makes sense while the run may continue
  if (out.verdict === "proceed") out.innerBudgetSuggestion = suggestion;
  return out;
}
