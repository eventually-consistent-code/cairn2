import type { Phase, Tracker } from "../tracker/types.js";
export declare const canonicalPhaseName: (number: number, name: string) => string;
export declare function resolvePhaseParam(tracker: Tracker, phase: string): Promise<string>;
export declare function ensurePhase(tracker: Tracker, number: number, name: string): Promise<Phase>;
export interface IssueDrift {
    issueId: string;
    phase: number;
    reason: "missing" | "closed";
}
/**
 * The latest security audit no longer describes HEAD (#195): it was
 * written over a dirty tree, code commits landed after its stamp, or its
 * stamp can't be resolved any more. verify/ship stop on it like any
 * other flag; the fix is always "re-run /cairn:audit security".
 */
export interface StaleAuditDrift {
    reason: "stale-audit";
    scope: string;
    /** The record's stamped commit. */
    commit: string;
    /** Why it's stale — one of the three, human-readable in `detail`. */
    cause: "dirty" | "code-moved" | "unresolvable";
    /** Commits outside docs/ since the stamp (code-moved only). */
    codeCommitsSince?: number;
    detail: string;
}
/**
 * Work that went quiet (#218). An issue held in progress that nobody has
 * touched and no commit mentions, or a branch with commits and no recent
 * activity. Neither is an error — the point is only that silent work is
 * invisible work, and a scan that never says so lets it stay that way.
 * Advisory everywhere: ship does not stop on these.
 */
export interface StaleWorkDrift {
    reason: "stale-issue" | "stale-branch";
    /** The issue id, or the branch name. */
    ref: string;
    /** Whole days since the most recent sign of life. */
    idleDays: number;
    detail: string;
}
/**
 * A roadmap Status cell that no longer matched the evidence on disk
 * (#185) -- already rewritten by the scan that found it.
 *
 * The odd one out of the drift kinds on purpose: the others describe a
 * problem for a human to fix, this one describes a fix already made. The
 * Status column was the last piece of plan state nothing computed -- only
 * the route verb wrote a cell, by hand -- so a phase could sit verified
 * for a week with its row still saying "planned". Reporting the repair
 * rather than silently doing it keeps the scan honest about what it
 * touched; reporting nothing once the row is right keeps it quiet.
 */
export interface RoadmapRowDrift {
    reason: "roadmap-row";
    /** The phase whose row was patched. */
    phase: number;
    /** What the cell said. */
    from: string;
    /** What the phase dir says, now written. */
    to: string;
    detail: string;
}
export type DriftItem = IssueDrift | StaleAuditDrift | StaleWorkDrift | RoadmapRowDrift;
/** Days of silence before work is called stale. `drift.staleDays` overrides. */
export declare const DEFAULT_STALE_DAYS = 5;
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
export declare function staleBranchDrift(projectDir: string, staleDays?: number, now?: number): StaleWorkDrift[];
/**
 * Stale-security-audit check. Only the latest security-scoped record
 * counts; records without a stamp (pre-phase-21, or written outside git)
 * are never flagged — no retroactive drift.
 *
 * :param projectDir: repository root
 * :returns: the flag, or null when the latest security audit is current
 */
export declare function staleAuditDrift(projectDir: string): StaleAuditDrift | null;
/**
 * Flips `planned` -> `verified` for every phase whose directory carries a
 * VERIFICATION.md, in place, and reports each flip (#185).
 *
 * Deliberately narrow on both sides. Only a row that still says exactly
 * "planned" moves: any other wording is a human's -- "blocked", "shipped
 * (v7)", a struck-through row from `route remove` -- and a scan that
 * overwrote those would be a worse bug than the one it fixes. And only
 * rows the table already holds move: inventing a row for an unlisted
 * phase is route's job, not drift's.
 *
 * :param projectDir: repository root
 * :returns: one item per row repaired; empty when the table already agrees
 */
export declare function roadmapRowDrift(projectDir: string): RoadmapRowDrift[];
export declare function driftReport(tracker: Tracker, projectDir: string, opts?: {
    staleDays?: number;
    now?: number;
}): Promise<{
    flagged: DriftItem[];
    ok: string[];
}>;
