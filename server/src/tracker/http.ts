import { CairnError } from "../errors.js";

export type FetchLike = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FetchOpts = { retries?: number; backoffMs?: number; context?: string };

/**
 * Core retry/error-mapping loop shared by fetchJson and fetchPage.
 * Returns the raw Response on success (2xx) — callers handle body parsing.
 */
async function fetchRaw(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: FetchOpts = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const tag = (m: string) => (opts.context ? `[${opts.context}] ${m}` : m);
  let lastErr: CairnError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp: Response;
    try {
      resp = await fetchImpl(url, init);
    } catch (e) {
      lastErr = new CairnError("TRACKER_DOWN", tag(`network error calling ${url}: ${e}`));
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
      continue;
    }
    if (resp.ok) return resp;
    if (resp.status === 401 || resp.status === 403) {
      // 403 can be rate limiting on some APIs; only retry when marked as such
      const remaining = resp.headers.get("x-ratelimit-remaining");
      if (resp.status === 403 && remaining === "0") {
        lastErr = new CairnError("RATE_LIMITED", tag(`rate limited: ${url}`));
        if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      throw new CairnError("AUTH_MISSING", tag(`HTTP ${resp.status} from ${url}`),
        "check the token env var for this backend");
    }
    if (resp.status === 404) throw new CairnError("NOT_FOUND", tag(`404 from ${url}`));
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = new CairnError(resp.status === 429 ? "RATE_LIMITED" : "TRACKER_DOWN",
        tag(`HTTP ${resp.status} from ${url}`));
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
      continue;
    }
    throw new CairnError("TRACKER_DOWN", tag(`HTTP ${resp.status} from ${url}`));
  }
  throw lastErr ?? new CairnError("TRACKER_DOWN", tag(`exhausted retries: ${url}`));
}

/** Parses a successful Response body as JSON, mapping malformed bodies to a typed error. */
async function parseJson(resp: Response, url: string, opts: FetchOpts): Promise<unknown> {
  const tag = (m: string) => (opts.context ? `[${opts.context}] ${m}` : m);
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CairnError("TRACKER_DOWN", tag(`malformed JSON response from ${url}`));
  }
}

export async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: FetchOpts = {},
): Promise<unknown> {
  const resp = await fetchRaw(fetchImpl, url, init, opts);
  return parseJson(resp, url, opts);
}

const NEXT_RE = /<([^>]+)>;\s*rel="next"/;
const MAX_PAGES = 10;

/** fetchRaw + parse + Link-header rel="next" extraction, for one page. */
async function fetchPage(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: FetchOpts,
): Promise<{ body: unknown; next: string | undefined }> {
  const resp = await fetchRaw(fetchImpl, url, init, opts);
  const body = await parseJson(resp, url, opts);
  const match = NEXT_RE.exec(resp.headers.get("link") ?? "");
  return { body, next: match?.[1] };
}

/**
 * Follows RFC-5988 Link: rel="next" headers, concatenating array pages.
 * Hard-caps at MAX_PAGES pages; logs a truncation warning if the cap is hit
 * while a next link is still present (never silently drops data).
 */
export async function paginate(
  fetchImpl: FetchLike,
  firstUrl: string,
  init: RequestInit,
  opts: FetchOpts = {},
): Promise<unknown[]> {
  const out: unknown[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const { body, next } = await fetchPage(fetchImpl, url, init, opts);
    if (Array.isArray(body)) out.push(...body);
    url = next;
    if (url && page === MAX_PAGES - 1)
      console.error(`[cairn] pagination truncated at ${MAX_PAGES} pages for ${firstUrl}`);
  }
  return out;
}
