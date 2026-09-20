/**
 * Evidence for `audit memory` (#171). The server computes facts; the verb
 * scores them against its rubric and decides what to propose.
 *
 * The motivating rot is invisible by construction: `listCards` skips a card
 * whose frontmatter will not parse, so a corrupted card disappears from
 * every list and every recall without ever announcing itself. Nothing in
 * the system could previously answer "what is the card store hiding?".
 *
 * Deliberately independent of the FTS index. The index needs a compiled
 * native binding, and a plugin cache installed under a newer node ABI ships
 * without one — a failure seen live on 2026-09-20. A memory audit that dies
 * exactly when memory is unhealthy is the wrong shape, so everything here
 * reads plain files and git.
 */
/** A card file that exists on disk but cannot be read back. */
export interface MalformedCard {
    file: string;
    /** The validation message, trimmed to one line — enough to fix by hand. */
    error: string;
}
/** A provenance entry whose commit or file no longer checks out. */
export interface ProvenanceBreak {
    id: string;
    reasons: string[];
}
/** Two cards whose bodies overlap enough to be worth a human look. */
export interface NearDuplicate {
    a: string;
    b: string;
    /** Jaccard overlap of significant tokens, 0..1, rounded to 2dp. */
    similarity: number;
}
export interface AgedCard {
    id: string;
    created: string;
    ageDays: number;
    confidence: string;
}
export interface MemoryAudit {
    counts: {
        total: number;
        readable: number;
        byType: Record<string, number>;
        byConfidence: Record<string, number>;
    };
    malformed: MalformedCard[];
    provenanceBroken: ProvenanceBreak[];
    nearDuplicates: NearDuplicate[];
    aged: AgedCard[];
}
/** Default: a low-confidence card older than this is a compaction candidate. */
export declare const AGED_DAYS = 90;
/** Jaccard threshold over significant body tokens. Tuned to surface, not to decide. */
export declare const DUPLICATE_SIMILARITY = 0.6;
/**
 * Computes the audit. Never throws on a bad card — surfacing bad cards is
 * the job, so a failure to read one is a finding rather than an error.
 *
 * :param projectDir: repository root
 * :param now: injectable clock for age math
 * :returns: the evidence block
 */
export declare function auditMemory(projectDir: string, now?: number): MemoryAudit;
