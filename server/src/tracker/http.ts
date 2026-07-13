import { CairnError } from "../errors.js";

export type FetchLike = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: { retries?: number; backoffMs?: number; context?: string } = {},
): Promise<unknown> {
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
    if (resp.ok) {
      const text = await resp.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new CairnError("TRACKER_DOWN", tag(`malformed JSON response from ${url}`));
      }
    }
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
