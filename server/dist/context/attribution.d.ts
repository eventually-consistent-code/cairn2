/**
 * Rent per unit of delivered work.
 *
 * The obvious denominator -- whatever issue the active-context tag named when
 * a session stopped -- covers 7 of 33 recorded sessions and 4 distinct issues
 * in total. So work is counted from durable timestamped facts instead: issues
 * the tracker closed and commits the repo landed, joined to the session spans
 * they fall inside. Nothing here fetches; callers supply both lists, which is
 * what makes it testable without a tracker or a git repo.
 */
export interface SessionSpan {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    /**
     * Context tokens this session paid -- and NOT one measurement, which is
     * why `rentBasis` rides beside it:
     *   - `ctx_sum`: Sigma(input + cache_write + cache_read) over the session's
     *     turns, the metrics row's `context.ctx_sum` field;
     *   - `cache_read`: the row's `cache_read_tokens` alone, which is what a
     *     row written before `context` existed can offer. Strictly smaller --
     *     it omits input and cache-write entirely.
     * A total summed across both is a mixture. Report the mix; do not coerce
     * the two into agreement.
     */
    rent: number;
    /** Which quantity `rent` is. */
    rentBasis: "ctx_sum" | "cache_read";
}
export interface WorkItem {
    id: string;
    closedAt: string;
    kind: "issue" | "commit";
}
export interface ItemRent {
    id: string;
    kind: "issue" | "commit";
    rent: number;
    sessions: string[];
}
export interface RentAttribution {
    items: ItemRent[];
    /** Rent from sessions that closed nothing -- overhead, not free. */
    unclaimedRent: number;
    /** Items closed inside no session span; reported, never silently dropped. */
    orphanItems: string[];
    rentPerItem: number;
}
/**
 * An item is attributed to every session whose span contains its close, and a
 * session's rent divides evenly among the items it closed. A session spanning
 * two closes therefore contributes half its rent to each; an item closed
 * during two overlapping sessions carries rent from both. Double-counting
 * across overlapping sessions is deliberate -- both sessions really did pay.
 *
 * :param spans: session spans with their rent
 * :param items: work items with close timestamps
 * :returns attribution with unclaimed rent and orphans reported separately
 */
export declare function attributeRent(spans: SessionSpan[], items: WorkItem[]): RentAttribution;
