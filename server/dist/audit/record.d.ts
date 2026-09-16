/**
 * Purpose: the audit record writer — the single place a review/audit pass
 * lands its findings (.cairn/audit/<scope>-<date>.md). Since phase 21 it
 * is also where a finding is JUDGED: every finding carries a typed
 * failure_scenario, critical/important findings carry a refutation panel
 * whose quorum is computed here (never model-asserted), REFUTED findings
 * stay in the record but never reach the tracker, and survivors credit
 * the raising seats' yield. The record is stamped with the commit it
 * judged.
 * Author(s): John Reed
 */
export type AuditSeverity = "critical" | "important" | "minor";
/** One verifier's vote on one finding. */
export type PanelVerdict = "CONFIRMED" | "PLAUSIBLE" | "REFUTED";
export interface PanelVote {
    /** The lens the verifier read with (a roster seat name, or a peer). */
    seat: string;
    verdict: PanelVerdict;
    /** What the verifier actually checked — the evidence behind the vote. */
    evidence: string;
}
/** How the quorum landed for one finding. */
export type FindingOutcome = "confirmed" | "plausible" | "refuted" | "unpanelled";
export interface AuditFinding {
    severity: AuditSeverity;
    title: string;
    /**
     * The concrete failure — "inputs/state → wrong output/crash". Required
     * since phase 21: a finding without one is a hunch, and the prose bar
     * ("name the scenario or cut it") is now enforced here, not asked for.
     */
    failure_scenario: string;
    detail?: string;
    issue?: string;
    /**
     * Refutation panel (#196). Required on critical/important findings —
     * at least one vote, two on a security scope; the quorum below decides
     * whether the finding survives to the tracker. Optional on minors.
     */
    panel?: PanelVote[];
    /** Seats that raised the finding (dedup's credit list) — yield attribution. */
    seats?: string[];
}
export interface FindingResult {
    title: string;
    severity: AuditSeverity;
    outcome: FindingOutcome;
    /** False only when the panel refuted it — the verb must not file it. */
    survived: boolean;
}
export interface AuditRecordResult {
    path: string;
    /** Total findings written, refuted ones included. */
    findings: number;
    /** Findings that may reach the tracker. */
    survived: number;
    /** Findings the panel killed — in the record, never in the tracker. */
    refuted: number;
    results: FindingResult[];
    commit?: string;
    dirty?: boolean;
    /** Advisory: the yield store couldn't be credited (never fails the write). */
    note?: string;
}
/** Panel votes a critical/important finding needs before the record accepts it. */
export declare function requiredVotes(scope: string, severity: AuditSeverity): number;
/**
 * The quorum rule, computed in code (CONTEXT.md, phase 21): a finding is
 * REFUTED only when REFUTED votes hold a strict majority; CONFIRMED when
 * confirmations outnumber refutations; otherwise PLAUSIBLE (ties, or a
 * panel that could neither prove nor disprove) — plausible survives,
 * marked. No panel at all is "unpanelled" and survives (legal on minors
 * only; the writer refuses it elsewhere).
 *
 * :param panel: the votes, possibly empty/undefined
 * :returns: the outcome
 */
export declare function judgePanel(panel: PanelVote[] | undefined): FindingOutcome;
/**
 * Validates, judges, and writes the record; credits yield for survivors.
 *
 * :param projectDir: repository root (record path + revision stamp)
 * :param scope: kebab-case mode+target ("security-21", "review-working")
 * :param verdict: "pass" (no findings) or "findings"
 * :param findings: the full finding list, refuted-to-be included
 * :param opts.yieldBaseDir: yield store root override (test seam)
 * :returns: path, counts, per-finding outcomes, stamp
 * :raises CairnError: UNSUPPORTED on shape errors; PRECONDITION_FAILED
 *   on verdict mismatch, a missing failure_scenario, or a missing panel
 */
export declare function writeAuditRecord(projectDir: string, scope: string, verdict: "pass" | "findings", findings: AuditFinding[], opts?: {
    yieldBaseDir?: string;
}): AuditRecordResult;
export interface AuditRecordSummary {
    scope: string;
    date: string;
    verdict: string;
    path: string;
    /** Revision stamp — undefined on records written before phase 21 or outside git. */
    commit?: string;
    dirty?: boolean;
}
export declare function listAuditRecords(projectDir: string): AuditRecordSummary[];
