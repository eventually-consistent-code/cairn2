import { describe, it, expect, vi } from "vitest";
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

  it("does not sleep after the final failed attempt", async () => {
    const f: FetchLike = async () => res(500);
    const start = Date.now();
    await expect(fetchJson(f, "https://x", {}, { retries: 0, backoffMs: 1000 }))
      .rejects.toMatchObject({ code: "TRACKER_DOWN" });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("prefixes errors with context when provided", async () => {
    const f: FetchLike = async () => res(404);
    await expect(fetchJson(f, "https://x", {}, { context: "github issue_get" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("[github issue_get]") });
  });

  it("maps malformed 2xx JSON to typed TRACKER_DOWN", async () => {
    const f: FetchLike = async () => new Response("<html>oops</html>", { status: 200 });
    await expect(fetchJson(f, "https://x", {}, { context: "t op" }))
      .rejects.toMatchObject({ code: "TRACKER_DOWN", message: expect.stringContaining("malformed JSON") });
  });

  it("paginate follows Link rel=next and concatenates pages", async () => {
    let call = 0;
    const f: FetchLike = async () => {
      call++;
      if (call === 1)
        return new Response(JSON.stringify([1, 2]), {
          status: 200,
          headers: { link: '<https://x?page=2>; rel="next"' },
        });
      return new Response(JSON.stringify([3]), { status: 200 });
    };
    const { paginate } = await import("../src/tracker/http.js");
    expect(await paginate(f, "https://x", {})).toEqual([1, 2, 3]);
    expect(call).toBe(2);
  });

  it("paginate caps at 10 pages and warns on truncation", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    const f: FetchLike = async () => {
      call++;
      return new Response(JSON.stringify([call]), {
        status: 200,
        headers: { link: `<https://x?page=${call + 1}>; rel="next"` }, // always another page
      });
    };
    const { paginate } = await import("../src/tracker/http.js");
    const out = await paginate(f, "https://x", {});
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(call).toBe(10);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pagination truncated"));
    warn.mockRestore();
  });
});

describe("fetchJson error bodies (#46)", () => {
  it("folds a truncated response body into the 401 message", async () => {
    const f: FetchLike = async () => res(401, { message: "invalid credentials supplied" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "AUTH_MISSING",
      message: expect.stringContaining("invalid credentials supplied"),
    });
  });

  it("folds a truncated response body into the 404 message", async () => {
    const f: FetchLike = async () => res(404, { message: "no such issue CHN-9" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("no such issue CHN-9"),
    });
  });

  it("folds a truncated response body into the exhausted 429 message", async () => {
    const f: FetchLike = async () => res(429, { message: "slow down please" });
    await expect(fetchJson(f, "https://x", {}, { retries: 0, backoffMs: 1 })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("slow down please"),
    });
  });

  it("folds a truncated response body into the generic non-ok message", async () => {
    const f: FetchLike = async () => res(418, { message: "teapot in maintenance" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "TRACKER_DOWN",
      message: expect.stringContaining("teapot in maintenance"),
    });
  });

  it("truncates an oversized body to ~200 chars", async () => {
    const long = "x".repeat(500);
    const f: FetchLike = async () => res(401, { message: long });
    let caught: unknown;
    try {
      await fetchJson(f, "https://x", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The core "HTTP 401 from ..." prefix plus a bounded body snippet -- well
    // short of the full 500-char (plus JSON quoting) body.
    expect(message.length).toBeLessThan(300);
  });

  it("classifies an auth-shaped 400 body as AUTH_MISSING", async () => {
    const f: FetchLike = async () => res(400, { message: "the access token is invalid" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({ code: "AUTH_MISSING" });
  });

  it("leaves a plain non-auth 400 body as TRACKER_DOWN", async () => {
    const f: FetchLike = async () => res(400, { message: "bad request: missing field 'title'" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({ code: "TRACKER_DOWN" });
  });

  it("nextAction calls out a rejected token", async () => {
    const f: FetchLike = async () => res(401, { message: "the token was rejected" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "AUTH_MISSING",
      nextAction: expect.stringContaining("regenerate"),
    });
  });

  it("nextAction calls out a missing scope/permission", async () => {
    const f: FetchLike = async () => res(403, { message: "missing required scope for this operation" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "AUTH_MISSING",
      nextAction: expect.stringContaining("scope"),
    });
  });

  it("nextAction calls out an org policy block", async () => {
    const f: FetchLike = async () => res(401, { message: "blocked by organization policy" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "AUTH_MISSING",
      nextAction: expect.stringContaining("policy"),
    });
  });

  it("nextAction falls back to the generic token hint when the body is unhelpful", async () => {
    const f: FetchLike = async () => res(401, { message: "nope" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({
      code: "AUTH_MISSING",
      nextAction: expect.stringContaining("check the token env var"),
    });
  });

  it("maps a 422 validation rejection to TRACKER_REJECTED with snippet + nextAction (#72)", async () => {
    let calls = 0;
    const f: FetchLike = async () =>
      (calls++, res(422, { message: "Validation Failed: milestone does not exist" }));
    await expect(fetchJson(f, "https://x", {}, { retries: 3, backoffMs: 1 })).rejects.toMatchObject({
      code: "TRACKER_REJECTED",
      message: expect.stringContaining("milestone does not exist"),
      nextAction: expect.stringContaining("the tracker rejected the request"),
    });
    expect(calls).toBe(1); // a rejection is deterministic — retrying it is noise
  });

  it("still classifies an auth-shaped 400 body as AUTH_MISSING, not TRACKER_REJECTED (#72)", async () => {
    const f: FetchLike = async () => res(400, { message: "the access token is invalid" });
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({ code: "AUTH_MISSING" });
  });

  it("keeps 500 as TRACKER_DOWN — server faults are not rejections (#72)", async () => {
    const f: FetchLike = async () => res(500, { message: "internal error" });
    await expect(fetchJson(f, "https://x", {}, { retries: 0, backoffMs: 1 }))
      .rejects.toMatchObject({ code: "TRACKER_DOWN" });
  });

  it("keeps a network error as TRACKER_DOWN (#72)", async () => {
    const f: FetchLike = async () => { throw new Error("ECONNRESET"); };
    await expect(fetchJson(f, "https://x", {}, { retries: 0, backoffMs: 1 }))
      .rejects.toMatchObject({ code: "TRACKER_DOWN" });
  });

  it("still throws the right code when the body read itself fails", async () => {
    const badResp = {
      ok: false,
      status: 401,
      headers: new Headers(),
      text: () => Promise.reject(new Error("stream already consumed")),
    } as unknown as Response;
    const f: FetchLike = async () => badResp;
    await expect(fetchJson(f, "https://x", {})).rejects.toMatchObject({ code: "AUTH_MISSING" });
  });
});
