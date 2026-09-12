/**
 * Purpose: the seat-finding dedup engine — N seats over one target
 * collapse to ONE finding set before anything reaches the tracker (the
 * phase's hard requirement). Pure library, no tool surface: review and
 * audit are agent-side verbs, so the coordinator calls this via node
 * against dist when it needs the reference merge, and the server consumes
 * it in future pipelines — same precedent as composeBrief in brief.ts.
 * Dependency-free and deterministic on purpose: shuffled input, same
 * output, every time.
 * Author(s): John Reed
 */
export declare const LINE_WINDOW = 2;
export declare const CLAIM_SIMILARITY_THRESHOLD = 0.5;
export declare const SEVERITIES: readonly ["critical", "important", "minor"];
export type Severity = (typeof SEVERITIES)[number];
/** One seat's raw finding, exactly as the seat raised it. */
export interface SeatFinding {
    /** Name of the seat that raised it (e.g. "security"). */
    seat: string;
    /** File the finding points at. */
    file: string;
    /** 1-based line the finding points at. */
    line: number;
    /** The claim — what's wrong, in the seat's words. */
    claim: string;
    severity: Severity;
    /** The seat's anchored 0-10 score for its walk, when it gave one. */
    score?: number;
}
/** One seat's credit on a merged finding — name plus its own score. */
export interface SeatCredit {
    seat: string;
    score?: number;
}
/** One deduplicated finding, crediting every seat that raised it. */
export interface DedupedFinding {
    file: string;
    /** Lowest line among the merged findings (the cluster anchor). */
    line: number;
    /** Canonical claim — from the highest-severity raising finding. */
    claim: string;
    /** Highest severity any raising seat assigned. */
    severity: Severity;
    /** Every raising seat, sorted by name, each with its own score. */
    seats: SeatCredit[];
}
/**
 * Collapses N seats' findings over one target into one finding set.
 *
 * Merge rule (documented here, tested in test/dedup.test.ts): two
 * findings merge when they name the SAME file, sit within LINE_WINDOW
 * (±2) lines of the cluster's anchor — its lowest-line member — and
 * their claims match: exact normalized text, or normalized-token Jaccard
 * overlap at or above CLAIM_SIMILARITY_THRESHOLD (0.5). Distinct claims
 * at the same location stay separate findings.
 *
 * A merged finding credits every raising seat (`seats`, sorted by name,
 * one entry per seat with that seat's own score attributed), keeps the
 * HIGHEST severity any seat assigned, anchors at the lowest merged line,
 * and carries the claim of the highest-severity raising finding.
 *
 * Deterministic: input is sorted (file, line, severity, seat, claim)
 * before clustering, so shuffled input yields byte-identical output.
 * Output order is (file, line, severity, claim).
 *
 * :param findings: raw per-seat findings, any order
 * :returns: the deduplicated finding set, deterministically ordered
 */
export declare function dedupFindings(findings: SeatFinding[]): DedupedFinding[];
