// Purpose: per-phase token/cost estimator (#129) -- predict a phase's
//   approximate agent-token spend as a RANGE before it runs, calibrated from
//   the metrics history the Stop hook writes (~/.cairn/metrics/<hashed>.jsonl).
//   Rows there are CUMULATIVE per session, so every read collapses to the
//   LATEST row per session_id first -- summing raw rows would multiply-count.
//   The collapse is reimplemented here rather than shared with
//   hooks/scripts/cost-report.mjs on purpose: hook scripts are dependency-free
//   by design and must never import server code (see hooks/scripts/lib.mjs),
//   so the ~10-line collapse lives on both sides of that wall.
//   Deterministic given its inputs -- no Date.now, no randomness. An estimate
//   you can't reproduce is an estimate you can't trust.
//
//   Per-issue grain (#144): history phases keep their PLAN.md issue lists
//   after summit archives them -- milestones/vN/<phase>/PLAN.md, the dir
//   moves wholesale (see milestoneComplete). Both live and archived plans
//   feed the tokens-per-issue distribution; real (phase total, issue count)
//   pairs are what let a 4-issue phase estimate differently from a 3-issue
//   one instead of both inheriting the same whole-phase envelope.
//
//   Cushion tightening curve (#144) -- a simple step function on the sample
//   count of the distribution being spanned, nothing cleverer:
//     n <= 2 samples: 0.75 / 1.25  (thin history -- the original cushions)
//     3 <= n <= 5:    0.85 / 1.15
//     n >= 6:         0.90 / 1.10  (floor -- token spend stays noisy)
//   Rationale: each step needs enough real pairs to trust the min/max span
//   itself before the cushion shrinks, and the floor admits that agent runs
//   never get more predictable than roughly +/-10%. Only size-normalized
//   grains (per-issue, per-point) tighten; the whole-phase fallback keeps
//   the thin cushion forever because it can't see the target's size.
// Author(s): John Reed
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { metricsPath } from "../core/continuity.js";
import { isValidPhaseNumber, PHASE_NUMBER_ERROR, parsePhaseDirName, plansRoot, } from "./artifacts.js";
import { parsePlanDoc } from "./frontmatter.js";
// -- published wide defaults (no-history fallback) ----------------------------
// Anchored to observed cairn2 phases (~150k-870k counted tokens each, 4-8
// issues): honest order-of-magnitude bounds, not precision.
export const DEFAULT_TOKENS_PER_ISSUE = { low: 25_000, high: 250_000 };
export const DEFAULT_PHASE_TOKENS = { low: 100_000, high: 1_000_000 };
// USD per 1M counted tokens when no history rate exists. Wide because cache
// traffic (excluded from the token unit, included in real cost) dominates.
export const DEFAULT_USD_PER_MTOK = { low: 50, high: 250 };
// Cushion applied around history-derived bounds -- admits estimator error and
// turns a single-sample "distribution" into a real range. Thin cushion is the
// original 0.75/1.25; the curve (see header) narrows it as real sample pairs
// accumulate. Steps are checked widest-threshold-first.
const THIN_CUSHION = { low: 0.75, high: 1.25 };
const CUSHION_STEPS = [
    { minSamples: 6, low: 0.9, high: 1.1 },
    { minSamples: 3, low: 0.85, high: 1.15 },
];
/** Cushion for a size-normalized grain with `n` samples -- steps down per the
 *  header's curve. The whole-phase fallback never calls this (stays thin). */
function cushionFor(n) {
    for (const step of CUSHION_STEPS) {
        if (n >= step.minSamples)
            return { low: step.low, high: step.high };
    }
    return THIN_CUSHION;
}
// The plan verb's body-line degrade convention for estimate-less backends:
// "Estimate: N points / ~Xh." -- points required, hours optional.
const ESTIMATE_LINE_RE = /^Estimate:\s*(\d+(?:\.\d+)?)\s*points?(?:\s*\/\s*~\s*(\d+(?:\.\d+)?)\s*h)?\.?\s*$/im;
/** Latest row per session_id -- append order means later lines win. Same
 *  collapse as cost-report.mjs's latestPerSession (see header for why it's
 *  duplicated, not shared). */
function collapseMetrics(path) {
    const bySession = new Map();
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const row = JSON.parse(line);
            if (typeof row.session_id === "string")
                bySession.set(row.session_id, row);
        }
        catch {
            // corrupt line -- skip, never guess
        }
    }
    return [...bySession.values()];
}
/** Resolve a phase number to its dir -- live under phases/, else archived
 *  under milestones/vN (newest vN wins, mirroring distill-manifest's rule).
 *  Archived phase dirs sit DIRECTLY under milestones/vN -- milestoneComplete
 *  renames phases/<dir> to milestones/vN/<dir>, no phases/ level in between
 *  (the old scan looked for one and never found archived plans, which is why
 *  completed history used to lose its per-issue grain). Returns null when
 *  the phase has no local dir at all. */
function findPhaseDir(projectDir, phaseNumber) {
    const root = plansRoot(projectDir);
    const scan = (dir, archived) => {
        if (!existsSync(dir))
            return null;
        for (const entry of readdirSync(dir)) {
            if (parsePhaseDirName(entry)?.number !== phaseNumber)
                continue;
            const base = join(dir, entry);
            return {
                base,
                issues: planIssuesAt(base),
                verified: existsSync(join(base, "VERIFICATION.md")),
                archived,
            };
        }
        return null;
    };
    const live = scan(join(root, "phases"), false);
    if (live)
        return live;
    const msDir = join(root, "milestones");
    if (existsSync(msDir)) {
        const versions = readdirSync(msDir)
            .filter((v) => /^v\d+$/.test(v))
            .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
        for (const v of versions) {
            const hit = scan(join(msDir, v), true);
            if (hit)
                return hit;
        }
    }
    return null;
}
function planIssuesAt(base) {
    const path = join(base, "PLAN.md");
    if (!existsSync(path))
        return [];
    try {
        return parsePlanDoc(readFileSync(path, "utf8")).frontmatter.issues;
    }
    catch {
        return [];
    }
}
/** Points for one issue: native estimate field first, body-line convention
 *  as the GitHub-class fallback. Null when neither carries a number. */
function issuePoints(issue) {
    if (issue.estimate?.points !== undefined)
        return issue.estimate.points;
    const m = ESTIMATE_LINE_RE.exec(issue.body ?? "");
    return m ? Number(m[1]) : null;
}
/** Sum of resolvable points across `ids`; null when none resolve (tracker
 *  absent, all lookups fail, or no issue carries an estimate). */
async function pointsFor(ids, tracker) {
    if (!tracker || ids.length === 0)
        return { total: null, missing: ids.length };
    let total = 0;
    let found = 0;
    for (const id of ids) {
        try {
            const p = issuePoints(await tracker.getIssue(id));
            if (p !== null) {
                total += p;
                found++;
            }
        }
        catch {
            // one dead lookup must not sink the estimate -- counted as missing
        }
    }
    return { total: found > 0 ? total : null, missing: ids.length - found };
}
const round2 = (n) => Number(n.toFixed(2));
/**
 * Estimate a phase's agent-token spend as a range, before it runs.
 *
 * Method: collapse metrics history (latest row per session, grouped by phase
 * tag), derive tokens-per-point / tokens-per-issue / tokens-per-phase
 * distributions from completed phases, then scale by the target phase's
 * points and issue count. No usable history degrades to a published wide
 * default with confidence "wide" and an honest note.
 *
 * "Tokens" here means input + output only -- cache traffic is excluded from
 * the unit but folded into the history-derived USD rate, so estUsd stays
 * honest about where the money actually goes.
 *
 * :param projectDir: project root (its .cairn/plans + hashed metrics file)
 * :param phaseNumber: target phase -- decimals accepted (1.5 slots between 1 and 2)
 * :param opts: metricsFile override (tests) + optional tracker for points
 */
export async function estimatePhaseTokens(projectDir, phaseNumber, opts = {}) {
    if (!isValidPhaseNumber(phaseNumber)) {
        throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(phaseNumber));
    }
    const notes = [];
    // -- target phase ----------------------------------------------------------
    const target = findPhaseDir(projectDir, phaseNumber);
    if (!target) {
        throw new CairnError("NOT_FOUND", `no phase ${phaseNumber} under .cairn/plans/phases or .cairn/plans/milestones`, "run plan_status to list live phases, or plan_scaffold_phase to create this one");
    }
    const issueCount = target.issues.length;
    const targetPoints = await pointsFor(target.issues, opts.tracker);
    if (issueCount > 0 && !opts.tracker) {
        notes.push("no tracker available -- points unknown, estimating from issue count only");
    }
    else if (issueCount > 0 && targetPoints.total === null) {
        notes.push("no issue in this phase carries a points estimate (native field or 'Estimate: N points' body line) -- estimating from issue count only");
    }
    else if (targetPoints.missing > 0) {
        notes.push(`${targetPoints.missing} of ${issueCount} issues carry no points estimate -- pointsTotal is a partial sum`);
    }
    // -- history ---------------------------------------------------------------
    const rows = collapseMetrics(opts.metricsFile ?? metricsPath(projectDir));
    const byPhase = new Map();
    for (const r of rows) {
        const p = Number(r.phase);
        if (r.phase === undefined || r.phase === null || Number.isNaN(p))
            continue;
        const g = byPhase.get(p) ?? { tokens: 0, usd: 0 };
        g.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
        g.usd += r.est_cost_usd ?? 0;
        byPhase.set(p, g);
    }
    const perPhase = []; // total counted tokens per completed phase
    const perIssue = []; // tokens per issue, where issue count known
    const perIssuePhases = []; // which phases contributed those pairs
    const perPoint = []; // tokens per point, where points known
    const rates = []; // usd per counted token
    let skippedInFlight = 0;
    const used = [];
    for (const [p, g] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
        if (p === phaseNumber || g.tokens <= 0)
            continue;
        const info = findPhaseDir(projectDir, p);
        if (info && !info.archived && !info.verified) {
            skippedInFlight++; // live but unverified -- still in flight, not history
            continue;
        }
        used.push(p);
        perPhase.push(g.tokens);
        if (g.usd > 0)
            rates.push(g.usd / g.tokens);
        if (info && info.issues.length > 0) {
            perIssue.push(g.tokens / info.issues.length);
            perIssuePhases.push(p);
            const pts = await pointsFor(info.issues, opts.tracker);
            if (pts.total !== null && pts.total > 0)
                perPoint.push(g.tokens / pts.total);
        }
    }
    if (skippedInFlight > 0) {
        notes.push(`${skippedInFlight} phase(s) with metrics skipped as still in flight (live dir, no VERIFICATION.md)`);
    }
    // -- combine ---------------------------------------------------------------
    const span = (samples, scale, cushion) => ({
        low: Math.min(...samples) * scale * cushion.low,
        high: Math.max(...samples) * scale * cushion.high,
    });
    const pct = (c) => `-${Math.round((1 - c.low) * 100)}%/+${Math.round((c.high - 1) * 100)}%`;
    const candidates = [];
    if (perPoint.length > 0 && targetPoints.total !== null && targetPoints.total > 0) {
        const cushion = cushionFor(perPoint.length);
        candidates.push(span(perPoint, targetPoints.total, cushion));
        notes.push(`tokens-per-point calibrated from ${perPoint.length} completed phase(s), cushion ${pct(cushion)}`);
    }
    if (perIssue.length > 0 && issueCount > 0) {
        const cushion = cushionFor(perIssue.length);
        candidates.push(span(perIssue, issueCount, cushion));
        notes.push(`tokens-per-issue calibrated from ${perIssue.length} completed phase(s) (${perIssuePhases.join(", ")}), cushion ${pct(cushion)}`);
    }
    if (candidates.length === 0 && perPhase.length > 0) {
        // whole-phase totals can't see the target's size -- thin cushion forever
        candidates.push(span(perPhase, 1, THIN_CUSHION));
        notes.push(`no per-issue grain available (no PLAN.md issue list found for history phases, live or archived) -- range scaled from ${perPhase.length} completed phase total(s), cushion ${pct(THIN_CUSHION)}`);
    }
    let range;
    let confidence;
    if (candidates.length > 0) {
        // envelope union -- when two scalers disagree, honesty is the wider range
        range = {
            low: Math.round(Math.min(...candidates.map((c) => c.low))),
            high: Math.round(Math.max(...candidates.map((c) => c.high))),
        };
        confidence = "calibrated";
        notes.push(`calibrated from completed phase(s): ${used.join(", ")}`);
    }
    else {
        range = issueCount > 0
            ? {
                low: DEFAULT_TOKENS_PER_ISSUE.low * issueCount,
                high: DEFAULT_TOKENS_PER_ISSUE.high * issueCount,
            }
            : { ...DEFAULT_PHASE_TOKENS };
        confidence = "wide";
        notes.push("no usable metrics history for this project -- published wide default "
            + `(${issueCount > 0 ? `${DEFAULT_TOKENS_PER_ISSUE.low}-${DEFAULT_TOKENS_PER_ISSUE.high} tokens per issue` : `${DEFAULT_PHASE_TOKENS.low}-${DEFAULT_PHASE_TOKENS.high} tokens per phase`}); `
            + "treat as an order-of-magnitude guess, not a forecast");
    }
    const lowRate = rates.length > 0 ? Math.min(...rates) : DEFAULT_USD_PER_MTOK.low / 1e6;
    const highRate = rates.length > 0 ? Math.max(...rates) : DEFAULT_USD_PER_MTOK.high / 1e6;
    notes.push("token range counts input+output only; cache traffic is folded into the USD rate, not the token unit");
    return {
        phase: phaseNumber,
        range,
        unit: "tokens",
        estUsd: { low: round2(range.low * lowRate), high: round2(range.high * highRate) },
        basis: {
            historyPhases: used.length,
            pointsTotal: targetPoints.total,
            issueCount,
            perIssuePairs: perIssue.length,
        },
        confidence,
        notes,
    };
}
