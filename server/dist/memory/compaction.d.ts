import { type AgedCard } from "./audit.js";
import { type Card } from "./cards.js";
/**
 * Retro-gated card compaction (#172). The capacity guard could only ever
 * advise splitting work; a card store that grew had no compress, retire or
 * archive story at all. This is that story: when the store crosses its token
 * threshold, retro proposes merging the aged low-confidence cards into ONE
 * dated archive card whose provenance carries the retired cards' commits.
 *
 * Three rules the memory design fixes and this module must not bend:
 *
 *  - Card bodies are IMMUTABLE. The archive is a NEW card; the retired ones
 *    are deleted, never edited in place.
 *  - The trail survives. Every retired card's provenance pair is unioned onto
 *    the archive, so the commits that proved the lesson stay reachable.
 *  - Nothing is retired without a human approving that batch. `propose` and
 *    `compact` are separate calls, and `compact` executes the approved ids
 *    rather than re-deriving the candidates -- re-deriving at write time is
 *    exactly how an approval drifts away from what it approved.
 *
 * Rotation without time-decay: age selects candidates, but nothing is dropped
 * on a timer and no confidence silently rots. A card leaves the store only
 * through an approved compaction.
 *
 * Index-independent by construction, for the same reason audit.ts and
 * observations.ts are: the FTS index needs a compiled native binding that can
 * be missing, and a capacity action that dies exactly when memory is unhealthy
 * is the wrong shape. Everything here reads plain files.
 */
/**
 * Card-store size, in approximate tokens, at which compaction is proposed.
 *
 * Deliberately NOT `memory.tokenThreshold`: that knob (default 150000) sizes
 * the FTS index over the whole planning corpus, and a card store is a far
 * smaller thing. Measuring the store against the index's threshold would mean
 * the guard never fires. This wants promoting to `memory.cardTokenThreshold`
 * in config.ts, which is not this module's file.
 */
export declare const CARD_TOKEN_THRESHOLD = 20000;
/** Merging one card into an archive loses a body and reclaims nothing. */
export declare const COMPACTION_MIN_CARDS = 2;
/**
 * First words of an archive card's body -- the marker that keeps archives out
 * of their own candidate list. See `isArchiveCard`.
 */
export declare const ARCHIVE_MARKER = "Archived card set";
/**
 * True for a card this module wrote. An archive must never become a candidate
 * for a later compaction: it carries no confidence (so `auditMemory` already
 * skips it, ageing only low-confidence cards), and this marker is the explicit
 * belt to that implicit brace -- if the aged criteria ever widen, the trail
 * still must not erode one pass at a time.
 */
export declare function isArchiveCard(card: Pick<Card, "body">): boolean;
/** An aged card priced for the proposal. */
export interface CompactionCandidate extends AgedCard {
    /** Approximate tokens the body costs today. */
    tokens: number;
}
export interface CompactionProposal {
    /** Over threshold AND enough candidates -- the only state retro proposes on. */
    triggered: boolean;
    /** Plain-English why, whichever way it went. Rendered straight into the question. */
    reason: string;
    /** Approximate tokens the readable card bodies cost today. */
    storeTokens: number;
    /** What `storeTokens` was measured against. */
    threshold: number;
    overThreshold: boolean;
    /** Aged low-confidence cards, oldest first -- straight from `auditMemory`. */
    retiring: CompactionCandidate[];
    /** The body that would be written, so the human approves the real text. */
    archiveBody: string;
    provenanceFiles: string[];
    provenanceCommits: string[];
    /** Candidate tokens minus the archive body's own cost, floored at 0. */
    tokensReclaimed: number;
}
export interface CompactionResult {
    archiveId: string;
    /** Ids whose files are now gone, in the order they were retired. */
    retired: string[];
    provenanceFiles: string[];
    provenanceCommits: string[];
    tokensReclaimed: number;
}
/**
 * Renders the archive body. Deterministic: the same card set on the same date
 * produces the same bytes, so a compaction retried after a half-finished run
 * rewrites the identical card rather than spawning a second one (the id is a
 * hash of this body).
 *
 * :param cards: the cards being retired, any order
 * :param date: ISO date (YYYY-MM-DD) stamped into the header
 * :returns: the archive body text
 */
export declare function renderArchiveBody(cards: Card[], date: string): string;
/**
 * Builds the compaction proposal retro puts in front of the human. Reads only
 * plain files and never throws on a bad card -- `auditMemory` already treats an
 * unreadable card as a finding rather than an error.
 *
 * Candidates come from `auditMemory(...).aged` rather than a second copy of the
 * aged criteria: two derivations of "aged low-confidence" would drift apart, and
 * the one that drifts is the one that deletes cards.
 *
 * :param projectDir: repository root
 * :param opts.now: injectable clock for age math and the archive date
 * :param opts.threshold: override the card-store token threshold
 * :returns: the proposal, triggered or not
 */
export declare function proposeCompaction(projectDir: string, opts?: {
    now?: number;
    threshold?: number;
}): CompactionProposal;
/**
 * Executes an approved compaction: writes the archive card, then retires the
 * approved ids.
 *
 * Executes exactly the ids the human approved. It does NOT re-run the proposal
 * -- between proposing and approving, a card can age in or a confidence can be
 * re-graded, and silently retiring something nobody saw is the failure this
 * verb exists to avoid. A card that vanished in the meantime is a loud
 * NOT_FOUND, not a quietly shorter batch.
 *
 * Write-then-delete, never the reverse: if the archive write fails, nothing is
 * retired. If a delete fails partway, the archive is already on disk and the
 * survivors can be retried -- the body is deterministic, so the retry rewrites
 * the same card rather than spawning a second one.
 *
 * :param projectDir: repository root
 * :param ids: the approved card ids; duplicates collapse, order is preserved
 * :param opts.now: injectable clock for the archive date
 * :returns: the archive id, what was retired, and the union provenance
 */
export declare function compactCards(projectDir: string, ids: string[], opts?: {
    now?: number;
}): CompactionResult;
