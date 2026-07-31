import { CairnError } from "../errors.js";

export type FetchLike = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FetchOpts = { retries?: number; backoffMs?: number; context?: string };

const BODY_SNIPPET_MAX = 200;

/**
 * Best-effort read of a non-ok response body, truncated to a diagnosable
 * snippet. The body read can itself fail (stream already consumed, network
 * hiccup mid-read, etc.) -- swallow that and fall back to an empty snippet
 * rather than letting a diagnostics nicety crash the real error we're
 * already in the middle of raising.
 */
async function readBodySnippet(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).trim();
    if (!text) return "";
    return text.length > BODY_SNIPPET_MAX ? `${text.slice(0, BODY_SNIPPET_MAX)}…` : text;
  } catch {
    return "";
  }
}

/** Appends a truncated response-body snippet to an error message core, when present. */
function withBody(core: string, body: string): string {
  return body ? `${core} — body: ${body}` : core;
}

// Case-insensitive signals that a body is talking about auth, not some other
// failure -- lets an auth-shaped 400 (many APIs return 400 instead of 401/403
// for a rejected token) classify as AUTH_MISSING instead of generic
// TRACKER_DOWN.
const AUTH_BODY_RE = /unauthoriz|authenticat|token|credential|permission|captcha|login/i;

function isAuthShapedBody(body: string): boolean {
  return AUTH_BODY_RE.test(body);
}

/**
 * Heuristic, honest nextAction for an AUTH_MISSING failure -- inspects the
 * body for the most specific cause it can name and falls back to the
 * generic "check the token env var" hint when nothing more specific shows.
 * Order matters: check the most specific signal first.
 */
function authNextAction(body: string): string {
  const b = body.toLowerCase();
  if (/token/.test(b)) return "token was rejected — regenerate or check it matches the account";
  if (/scope|permission/.test(b))
    return "token is missing a required scope or permission — check the app's OAuth scopes or the account's access level";
  if (/policy|blocked|disabled/.test(b))
    return "an org/workspace policy is blocking this token — check IP allowlists, SSO enforcement, or app restrictions";
  return "check the token env var for this backend";
}

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
      const body = await readBodySnippet(resp);
      throw new CairnError("AUTH_MISSING", tag(withBody(`HTTP ${resp.status} from ${url}`, body)),
        authNextAction(body));
    }
    if (resp.status === 404) {
      const body = await readBodySnippet(resp);
      throw new CairnError("NOT_FOUND", tag(withBody(`404 from ${url}`, body)));
    }
    // Many APIs return a plain 400 instead of 401/403 for a rejected token --
    // classify those auth-shaped bodies as AUTH_MISSING rather than letting
    // them fall through to the generic branch below.
    if (resp.status === 400) {
      const body = await readBodySnippet(resp);
      if (isAuthShapedBody(body)) {
        throw new CairnError("AUTH_MISSING", tag(withBody(`HTTP ${resp.status} from ${url}`, body)),
          authNextAction(body));
      }
      throw new CairnError("TRACKER_DOWN", tag(withBody(`HTTP ${resp.status} from ${url}`, body)));
    }
    if (resp.status === 429 || resp.status >= 500) {
      const body = await readBodySnippet(resp);
      lastErr = new CairnError(resp.status === 429 ? "RATE_LIMITED" : "TRACKER_DOWN",
        tag(withBody(`HTTP ${resp.status} from ${url}`, body)));
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
      continue;
    }
    {
      const body = await readBodySnippet(resp);
      throw new CairnError("TRACKER_DOWN", tag(withBody(`HTTP ${resp.status} from ${url}`, body)));
    }
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
 * Body-cursor variant of paginate for APIs that put the next link in the
 * response body (Confluence `_links.next`) instead of a Link header. The
 * caller's `extract` pulls items + the next cursor out of each page body;
 * relative cursors resolve against the first URL's origin. Same MAX_PAGES
 * cap and truncation warning as paginate.
 */
export async function paginateCursor(
  fetchImpl: FetchLike,
  firstUrl: string,
  init: RequestInit,
  extract: (body: unknown) => { items: unknown[]; next?: string },
  opts: FetchOpts = {},
): Promise<unknown[]> {
  const out: unknown[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body = await fetchJson(fetchImpl, url, init, opts);
    const { items, next } = extract(body);
    out.push(...items);
    url = next ? new URL(next, firstUrl).toString() : undefined;
    if (url && page === MAX_PAGES - 1)
      console.error(`[cairn] pagination truncated at ${MAX_PAGES} pages for ${firstUrl}`);
  }
  return out;
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
