/**
 * Rollup over the metrics rows the Stop hook writes.
 *
 * Computes nothing the hook already computed: residency rides the hook's
 * existing forward pass, and re-deriving it here would read every transcript
 * a second time to learn what a row already says.
 *
 * Rows are CUMULATIVE per session -- the latest row for a session_id is that
 * session's whole record, and summing rows would multiply-count every one.
 */
import type { SessionSpan } from "./attribution.js";
type Bands = {
    under150k: number;
    to300k: number;
    to500k: number;
    over500k: number;
};
export interface MetricsRow {
    ts: string;
    session_id: string;
    cache_read_tokens?: number;
    context?: {
        turns: number;
        turns_sidechain: number;
        ctx_sum: number;
        prefix_tokens: number;
        /** TURNS per band. Every row that has a `context` field has these. */
        bands: Bands;
        /** Context TOKENS summed per band. Absent on rows written before it existed. */
        band_tokens?: Bands;
        residency: Record<string, number>;
    };
}
export interface MeterReport {
    sessions: number;
    turns: number;
    /**
     * Summed session rent -- see `rentBasis`. This is NOT one measurement: a
     * row carrying `context.ctx_sum` contributes Sigma(input + cache_write +
     * cache_read); an older row without it contributes `cache_read_tokens`
     * alone, which is strictly smaller. Reported as one total because it is
     * the total that was paid, with the mix declared beside it.
     */
    rent: number;
    /** How many sessions contributed which quantity to `rent`, and how much. */
    rentBasis: {
        ctxSumSessions: number;
        ctxSumRent: number;
        cacheReadSessions: number;
        cacheReadRent: number;
    };
    avgContextPerTurn: number;
    sidechainTurnShare: number;
    /**
     * Share of context spend by band. Divided from summed TOKENS when any
     * session carries `band_tokens`, and from turn COUNTS otherwise -- a turn
     * share understates the high bands, because a high-band turn costs more.
     * `bandShare.basis` says which one this is.
     */
    bandRentShare: Record<string, number>;
    /** Which quantity `bandRentShare` divided, and the count-based share always. */
    bandShare: {
        basis: "tokens" | "turns" | "none";
        tokenSessions: number;
        turnOnlySessions: number;
        turnShare: Record<string, number>;
    };
    residency: Record<string, number>;
    prefixTokens: {
        p50: number;
        max: number;
    };
}
/**
 * :param rows: metrics rows, any number per session
 * :returns the rollup across the latest row of each session
 */
export declare function summarise(rows: MetricsRow[]): MeterReport;
/**
 * Session spans for attribution: first and last row timestamp, and the rent
 * from the latest row (rows being cumulative, the latest one is the total).
 *
 * :param rows: metrics rows, any number per session
 * :returns one span per session id
 */
export declare function sessionSpans(rows: MetricsRow[]): SessionSpan[];
export {};
