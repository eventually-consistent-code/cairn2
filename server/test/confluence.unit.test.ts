import { describe, it, expect } from "vitest";
import { ConfluenceConnector } from "../src/docs/adapters/confluence.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = [];
  const f: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const BASE = "https://x.atlassian.net/wiki";

function makeConn(f: FetchLike) {
  return new ConfluenceConnector(
    { baseUrl: BASE, spaceKey: "DOCS", emailEnv: "CONFLUENCE_EMAIL", tokenEnv: "CONFLUENCE_API_TOKEN" },
    f,
    () => ({ email: "e@x.io", token: "tok" }),
  );
}

const SPACE = { results: [{ id: 111, key: "DOCS", homepageId: 900 }] };
const rawPage = (over: Record<string, unknown> = {}) => ({
  id: 123, title: "T", parentId: 900, version: { number: 3 },
  _links: { webui: "/spaces/DOCS/pages/123/T" }, ...over,
});

describe("ConfluenceConnector", () => {
  it("sends Basic auth from the injected auth provider", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: rawPage() }]);
    await makeConn(f).getPage("123");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("e@x.io:tok").toString("base64")}`);
  });

  it("normalizes pages (string ids, version number, absolute url)", async () => {
    const { f } = fixtureFetch([{ status: 200, body: rawPage() }]);
    const p = await makeConn(f).getPage("123");
    expect(p).toEqual({
      id: "123", title: "T", parentId: "900", version: 3,
      url: `${BASE}/spaces/DOCS/pages/123/T`,
    });
  });

  it("maps 404 to NOT_FOUND", async () => {
    const { f } = fixtureFetch([{ status: 404, body: {} }]);
    await expect(makeConn(f).getPage("999")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps 401 to AUTH_MISSING", async () => {
    const { f } = fixtureFetch([{ status: 401, body: {} }]);
    await expect(makeConn(f).getPage("123")).rejects.toMatchObject({ code: "AUTH_MISSING" });
  });

  it("throws NOT_FOUND for a missing space", async () => {
    const { f } = fixtureFetch([{ status: 200, body: { results: [] } }]);
    await expect(makeConn(f).findPage("T")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("findPage filters by parent and memoizes the space lookup", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: { results: [rawPage({ parentId: 555 }), rawPage({ id: 124 })] } },
      { status: 200, body: { results: [rawPage({ id: 124 })] } },
    ]);
    const conn = makeConn(f);
    const p = await conn.findPage("T", "900");
    expect(p?.id).toBe("124");
    await conn.findPage("T", "900"); // second call — space lookup not repeated
    expect(calls.filter((c) => c.url.includes("/api/v2/spaces")).length).toBe(1);
  });

  it("findPage returns null when nothing matches", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: { results: [] } },
    ]);
    expect(await makeConn(f).findPage("Nope")).toBeNull();
  });

  it("listChildren follows body-cursor pagination and stamps parentId", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { results: [rawPage({ id: 1, parentId: undefined })],
        _links: { next: "/wiki/api/v2/pages/77/children?cursor=abc" } } },
      { status: 200, body: { results: [rawPage({ id: 2, parentId: undefined })] } },
    ]);
    const kids = await makeConn(f).listChildren("77");
    expect(kids.map((k) => k.id)).toEqual(["1", "2"]);
    expect(kids.every((k) => k.parentId === "77")).toBe(true);
    expect(calls[1].url).toBe("https://x.atlassian.net/wiki/api/v2/pages/77/children?cursor=abc");
  });

  it("createPage posts converted storage-format body under the space", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: rawPage() },
    ]);
    await makeConn(f).createPage({ title: "T", markdown: "# Hi", parentId: "900" });
    const post = calls[1];
    expect(post.method).toBe("POST");
    expect(post.body).toMatchObject({
      spaceId: "111", title: "T", parentId: "900",
      body: { representation: "storage", value: "<h1>Hi</h1>" },
    });
  });

  it("updatePage increments the current version", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: rawPage({ version: { number: 7 } }) },
      { status: 200, body: rawPage({ version: { number: 8 } }) },
    ]);
    const p = await makeConn(f).updatePage("123", { title: "T", markdown: "x" });
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body).toMatchObject({ version: { number: 8 } });
    expect(p.version).toBe(8);
  });

  it("ensureRoot returns an existing landing page without creating", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: { results: [rawPage({ id: 42, title: "proj", parentId: 900 })] } },
    ]);
    const root = await makeConn(f).ensureRoot("proj");
    expect(root.id).toBe("42");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("ensureRoot creates the landing page under the space homepage when absent", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: { results: [] } },
      { status: 200, body: rawPage({ id: 43, title: "proj" }) },
    ]);
    const root = await makeConn(f).ensureRoot("proj");
    expect(root.id).toBe("43");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ title: "proj", parentId: "900" });
  });
});
