/**
 * The auto-compact threshold cairn wants, against the one the harness has.
 *
 * Cairn cannot set an environment variable for a session that is already
 * running, and it will not edit a user's settings behind their back. So it
 * records a desired value and REPORTS the mismatch (ADR 0017) -- the fix is
 * the user's to apply, and probe output is where they learn it is needed.
 */
export interface ContextEconomyConfig {
    /**
     * Desired value of CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: the fraction of the
     * context window at which the harness compacts. Simulation over the
     * recorded corpus puts 0.2 at a ~50% rent reduction. null means no
     * preference -- the harness default stands.
     */
    autocompactPct: number | null;
}
export interface ThresholdDrift {
    status: "unset" | "match" | "drift" | "invalid";
    desired: number | null;
    live: number | null;
}
/**
 * :param desiredPct: the project's configured preference, or null
 * :param liveEnv: the raw CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value, or undefined
 * :returns the comparison, never throwing on bad input
 */
export declare function thresholdDrift(desiredPct: number | null, liveEnv: string | undefined): ThresholdDrift;
