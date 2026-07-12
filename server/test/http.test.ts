import { describe, it, expect } from "vitest";
import { fetchJson } from "../src/tracker/http.js";
import type { FetchLike } from "../src/tracker/http.js";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("fetchJson", () => {
  it("returns parsed JSON on 200", async () => {
    const f: FetchLike = async () => res(200, { ok: 1 });
    expect(await fetchJson(f, "https://x", {})).toEqual({ ok: 1 });
  });

  it("retries 429 then succeeds", async () => {
    let calls = 0;
    const f: FetchLike = async () => (++calls === 1 ? res(429) : res(200, { ok: 1 }));
    expect(await fetchJson(f, "https://x", {}, { retries: 2, backoffMs: 1 })).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("maps exhausted 429 to RATE_LIMITED", async () => {
    const f: FetchLike = async () => res(429);
    await expect(fetchJson(f, "https://x", {}, { retries: 1, backoffMs: 1 }))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("maps 401 to AUTH_MISSING and 404 to NOT_FOUND without retry", async () => {
    let calls = 0;
    const f401: FetchLike = async () => (calls++, res(401));
    await expect(fetchJson(f401, "https://x", {}, { retries: 3, backoffMs: 1 }))
      .rejects.toMatchObject({ code: "AUTH_MISSING" });
    expect(calls).toBe(1);
    const f404: FetchLike = async () => res(404);
    await expect(fetchJson(f404, "https://x", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps network error to TRACKER_DOWN after retries", async () => {
    const f: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    await expect(fetchJson(f, "https://x", {}, { retries: 1, backoffMs: 1 }))
      .rejects.toMatchObject({ code: "TRACKER_DOWN" });
  });
});
