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
export interface MetricsRow {
    ts: string;
    session_id: string;
    cache_read_tokens?: number;
    context?: {
        turns: number;
        turns_sidechain: number;
        ctx_sum: number;
        prefix_tokens: number;
        bands: {
            under150k: number;
            to300k: number;
            to500k: number;
            over500k: number;
        };
        residency: Record<string, number>;
    };
}
export interface MeterReport {
    sessions: number;
    turns: number;
    rent: number;
    avgContextPerTurn: number;
    sidechainTurnShare: number;
    bandRentShare: Record<string, number>;
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
