/**
 * Compaction boundaries, and whether crossing one cost anything.
 *
 * The harness compacts on its own -- a microcompact clears old tool results
 * in place, a full compaction summarises and restarts. Moving the threshold
 * from window-safety to cost-optimal makes boundaries far more frequent, so
 * the question "did that hurt" stops being academic.
 *
 * It cuts BOTH ways. Context-rot research finds recall degrading as context
 * grows, so a session riding 900k is also losing information -- just without
 * a marker in the transcript to blame. These detectors say what a boundary
 * cost; they do not assume the pre-boundary state was healthy.
 *
 * Deliberately crude, and deliberately only two. A third symptom -- a
 * decision reversed without new evidence -- needs semantic judgement this
 * cannot honestly fake, so boundary reports surface the surrounding turns
 * for a human to label rather than guessing.
 */
export interface TranscriptEntry {
    type?: string;
    subtype?: string;
    isSidechain?: boolean;
    message?: {
        role?: string;
        content?: unknown;
    };
}
export interface Boundary {
    index: number;
    kind: "microcompact" | "compact";
}
export interface Symptom {
    kind: "reread" | "repeat_question";
    boundaryIndex: number;
    evidence: string;
}
/**
 * :param entries: transcript entries in order
 * :returns one boundary per compaction event; a run of cleared markers is one
 */
export declare function findBoundaries(entries: TranscriptEntry[]): Boundary[];
/**
 * :param entries: transcript entries in order
 * :param boundaries: output of findBoundaries over the same entries
 * :returns symptoms attributed to the nearest preceding boundary
 *
 * "Before" a boundary is unbounded -- everything up to it, since a file read
 * long ago and re-read now is still evidence of that re-read, and a fact the
 * user gave at any earlier point still counts as already supplied. "After"
 * a boundary is bounded at the *next* boundary (or the end of the transcript
 * for the last one), so a single re-read or repeated question is attributed
 * to exactly one boundary -- the one it actually followed -- instead of to
 * every boundary that happens to precede it.
 */
export declare function detectSymptoms(entries: TranscriptEntry[], boundaries: Boundary[]): Symptom[];
