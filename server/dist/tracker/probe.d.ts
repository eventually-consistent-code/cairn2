import type { ProbeResult } from "./types.js";
/** Maps a caught error from a probe's cheap call onto a ProbeResult. */
export declare function probeVerdictForError(e: unknown): ProbeResult;
/**
 * Runs an adapter's cheap authenticated call and turns success/failure into
 * a ProbeResult. `check`'s return value is discarded -- only whether it
 * resolved or rejected (and how) matters.
 */
export declare function runProbe(check: () => Promise<unknown>): Promise<ProbeResult>;
