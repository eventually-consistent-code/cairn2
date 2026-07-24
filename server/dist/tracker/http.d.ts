export type FetchLike = typeof fetch;
type FetchOpts = {
    retries?: number;
    backoffMs?: number;
    context?: string;
};
export declare function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit, opts?: FetchOpts): Promise<unknown>;
/**
 * Body-cursor variant of paginate for APIs that put the next link in the
 * response body (Confluence `_links.next`) instead of a Link header. The
 * caller's `extract` pulls items + the next cursor out of each page body;
 * relative cursors resolve against the first URL's origin. Same MAX_PAGES
 * cap and truncation warning as paginate.
 */
export declare function paginateCursor(fetchImpl: FetchLike, firstUrl: string, init: RequestInit, extract: (body: unknown) => {
    items: unknown[];
    next?: string;
}, opts?: FetchOpts): Promise<unknown[]>;
/**
 * Follows RFC-5988 Link: rel="next" headers, concatenating array pages.
 * Hard-caps at MAX_PAGES pages; logs a truncation warning if the cap is hit
 * while a next link is still present (never silently drops data).
 */
export declare function paginate(fetchImpl: FetchLike, firstUrl: string, init: RequestInit, opts?: FetchOpts): Promise<unknown[]>;
export {};
