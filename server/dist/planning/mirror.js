import { execFileSync } from "node:child_process";
import { CairnError } from "../errors.js";
import { listAuditRecords } from "../audit/record.js";
import { isValidPhaseNumber, PHASE_NUMBER_ERROR } from "./artifacts.js";
import { codeCommitsSince } from "./resync.js";
import { projectStatus } from "./status.js";
export const canonicalPhaseName = (number, name) => `Phase ${number}: ${name}`;
// Tool-layer phase-param resolution (#138). issue_create's `phase` used to
// demand the tracker's internal phase-object id -- a mapping only
// plan_phase_ensure's return value knew, so passing the cairn phase number
// ("14") 422'd on GitHub. Resolve here, once, for every backend: an existing
// phase id passes through untouched (id wins on collision -- backward
// compatible), and a phase NUMBER resolves through the same canonical
// "Phase N: <name>" convention ensurePhase writes. One listPhases fetch
// serves both checks; no cross-call state.
const PHASE_NUMBER_RE = /^\d+(\.\d+)?$/;
export async function resolvePhaseParam(tracker, phase) {
    // backends without phases keep their existing adapter-side error path
    if (!tracker.capabilities.hasPhases)
        return phase;
    const phases = await tracker.listPhases();
    const byId = phases.find((p) => p.id === phase);
    if (byId)
        return byId.id;
    if (PHASE_NUMBER_RE.test(phase)) {
        const prefix = `Phase ${phase}:`;
        const byNumber = phases.find((p) => p.name.startsWith(prefix));
        if (byNumber)
            return byNumber.id;
        throw new CairnError("NOT_FOUND", `phase '${phase}' matched neither an existing tracker phase id nor a phase named 'Phase ${phase}: ...'`, "phase_list shows valid ids; plan_phase_ensure creates the 'Phase N: <name>' phase first");
    }
    throw new CairnError("NOT_FOUND", `phase '${phase}' matched no existing tracker phase id, and it is not a cairn phase number (integer or decimal), so the 'Phase N:' name lookup was skipped`, "phase_list shows valid ids; plan_phase_ensure creates the 'Phase N: <name>' phase first");
}
export async function ensurePhase(tracker, number, name) {
    if (!isValidPhaseNumber(number)) {
        throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(number));
    }
    if (!tracker.capabilities.hasPhases) {
        throw new CairnError("CONFIG_INVALID", "the configured tracker does not support phases", "phase mirroring requires a backend with milestones/epics/sections/lists");
    }
    const canonical = canonicalPhaseName(number, name);
    const existing = (await tracker.listPhases()).find((p) => p.name === canonical);
    if (existing)
        return existing;
    return tracker.createPhase(canonical);
}
/** Days of silence before work is called stale. `drift.staleDays` overrides. */
export const DEFAULT_STALE_DAYS = 5;
const DAY_MS = 86_400_000;
/** Whole days between `iso` and now; null when the stamp is unusable. */
function daysSince(iso, now) {
    if (!iso)
        return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return null;
    return Math.floor((now - t) / DAY_MS);
}
/**
 * Issue ids mentioned by any commit in the window, from ONE git pass.
 * Per-issue `git log --grep` would be a subprocess per tracked issue; this
 * is a single call whose output is searched in memory. Matching is
 * deliberately loose (the bare number, however it is written) because
 * commit conventions vary per project and a false "still active" is much
 * cheaper than nagging about work that is plainly moving.
 */
function idsMentionedSince(projectDir, days) {
    const out = new Set();
    let log;
    try {
        log = execFileSync("git", ["log", `--since=${days}.days.ago`, "--format=%s%n%b"], { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    }
    catch {
        return out; // not a repo, or no commits yet — no evidence either way
    }
    for (const m of log.matchAll(/\d+/g))
        out.add(m[0]);
    return out;
}
/**
 * Branches whose last commit is older than the window. Local and remote,
 * minus the default branch and whatever is checked out — the branch you
 * are standing on is not forgotten work.
 *
 * Deliberately git-only: "has no open pull request" would be the sharper
 * signal, but the tracker SPI has no pull-request surface, and inventing
 * one for an advisory flag is the wrong trade. A branch that IS under
 * review will show up here once it goes quiet, which is arguably correct
 * anyway — a review nobody has finished in a week is also stale work.
 */
export function staleBranchDrift(projectDir, staleDays = DEFAULT_STALE_DAYS, now = Date.now()) {
    let raw;
    let current = "";
    let head = "";
    try {
        raw = execFileSync("git", ["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)",
            "refs/heads", "refs/remotes"], { cwd: projectDir, encoding: "utf8" });
        current = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir, encoding: "utf8" }).trim();
        try {
            head = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: projectDir, encoding: "utf8" }).trim().replace(/^origin\//, "");
        }
        catch {
            head = ""; // no origin/HEAD (local-only repo) — fall through to the name list
        }
    }
    catch {
        return []; // not a git repo — nothing to say
    }
    const DEFAULTS = new Set(["main", "master", "trunk", "develop", current, head]
        .filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        const [refRaw, date] = line.split("\t");
        if (!refRaw || !date)
            continue;
        const ref = refRaw.replace(/^origin\//, "");
        if (ref === "HEAD" || DEFAULTS.has(ref) || seen.has(ref))
            continue;
        const idle = daysSince(date, now);
        if (idle === null || idle < staleDays)
            continue;
        seen.add(ref);
        out.push({
            reason: "stale-branch", ref, idleDays: idle,
            detail: `branch '${ref}' has had no commit for ${idle} days — finish it, or delete it`,
        });
    }
    return out.sort((a, b) => b.idleDays - a.idleDays || a.ref.localeCompare(b.ref));
}
const SECURITY_SCOPE_RE = /^security(-|$)/;
/**
 * Stale-security-audit check. Only the latest security-scoped record
 * counts; records without a stamp (pre-phase-21, or written outside git)
 * are never flagged — no retroactive drift.
 *
 * :param projectDir: repository root
 * :returns: the flag, or null when the latest security audit is current
 */
export function staleAuditDrift(projectDir) {
    const latest = listAuditRecords(projectDir)
        .filter((r) => SECURITY_SCOPE_RE.test(r.scope))
        .sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path))
        .at(-1);
    if (!latest?.commit)
        return null;
    const short = latest.commit.slice(0, 7);
    if (latest.dirty) {
        return { reason: "stale-audit", scope: latest.scope, commit: latest.commit, cause: "dirty",
            detail: `security audit '${latest.scope}' was recorded over uncommitted changes at ${short} — re-run /cairn:audit security on a clean tree` };
    }
    const moved = codeCommitsSince(projectDir, latest.commit);
    if (moved === null) {
        return { reason: "stale-audit", scope: latest.scope, commit: latest.commit, cause: "unresolvable",
            detail: `security audit '${latest.scope}' is stamped at ${short}, which this repository no longer resolves — re-run /cairn:audit security` };
    }
    if (moved > 0) {
        return { reason: "stale-audit", scope: latest.scope, commit: latest.commit, cause: "code-moved",
            codeCommitsSince: moved,
            detail: `security audit '${latest.scope}' at ${short} predates ${moved} code commit${moved === 1 ? "" : "s"} — re-run /cairn:audit security` };
    }
    return null;
}
export async function driftReport(tracker, projectDir, opts = {}) {
    const flagged = [];
    const ok = [];
    const stale = staleAuditDrift(projectDir);
    if (stale)
        flagged.push(stale);
    const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
    const now = opts.now ?? Date.now();
    // One git pass for the whole report, not one per issue.
    const mentioned = idsMentionedSince(projectDir, staleDays);
    flagged.push(...staleBranchDrift(projectDir, staleDays, now));
    for (const phase of projectStatus(projectDir).phases) {
        for (const issueId of phase.issues) {
            let issue;
            try {
                issue = await tracker.getIssue(issueId);
            }
            catch (e) {
                if (e instanceof CairnError && e.code === "NOT_FOUND") {
                    flagged.push({ issueId, phase: phase.number, reason: "missing" });
                    continue;
                }
                throw e; // rate limits / auth problems are NOT drift
            }
            const state = issue.category;
            if (state === "closed" && !phase.hasVerification) {
                flagged.push({ issueId, phase: phase.number, reason: "closed" });
            }
            else {
                // An issue held in progress that nobody has touched and no recent
                // commit names has gone quiet. Both signals must agree: a tracker
                // comment OR a commit counts as a sign of life.
                const idle = daysSince(issue.updatedAt, now);
                if (state === "in_progress" && idle !== null && idle >= staleDays &&
                    !mentioned.has(issueId)) {
                    flagged.push({
                        reason: "stale-issue", ref: issueId, idleDays: idle,
                        detail: `issue ${issueId} has been in progress for ${idle} days with no ` +
                            "tracker update and no commit naming it — pick it back up, park it, or hand it off",
                    });
                }
                ok.push(issueId);
            }
        }
    }
    return { flagged, ok };
}
