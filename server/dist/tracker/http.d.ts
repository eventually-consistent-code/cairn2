export type FetchLike = typeof fetch;
type FetchOpts = {
    retries?: number;
    backoffMs?: number;
    context?: string;
};
export declare function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit, opts?: FetchOpts): Promise<unknown>;
/**
 * Follows RFC-5988 Link: rel="next" headers, concatenating array pages.
 * Hard-caps at MAX_PAGES pages; logs a truncation warning if the cap is hit
 * while a next link is still present (never silently drops data).
 */
export declare function paginate(fetchImpl: FetchLike, firstUrl: string, init: RequestInit, opts?: FetchOpts): Promise<unknown[]>;
export {};
