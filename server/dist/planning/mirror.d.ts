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
export type DriftItem = IssueDrift | StaleAuditDrift;
/**
 * Stale-security-audit check. Only the latest security-scoped record
 * counts; records without a stamp (pre-phase-21, or written outside git)
 * are never flagged — no retroactive drift.
 *
 * :param projectDir: repository root
 * :returns: the flag, or null when the latest security audit is current
 */
export declare function staleAuditDrift(projectDir: string): StaleAuditDrift | null;
export declare function driftReport(tracker: Tracker, projectDir: string): Promise<{
    flagged: DriftItem[];
    ok: string[];
}>;
