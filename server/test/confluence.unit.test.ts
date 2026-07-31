import { describe, it, expect, vi } from "vitest";
import { ConfluenceConnector } from "../src/docs/adapters/confluence.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. Non-JSON
 *  bodies (FormData multipart uploads) are recorded raw instead of parsed. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string;
    headers?: Record<string, string> }> = [];
  const f: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (init?.body instanceof FormData) body = init.body;
    else if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = init.body; } }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body,
      auth: headers.authorization,
      headers,
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

  it("ensureRoot reuses an existing project folder + landing page (case-insensitive)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: { results: [{ content: { id: 8061115, title: "Proj" } }] } },
      { status: 200, body: { results: [rawPage({ id: 42, title: "proj", parentId: 8061115 })] } },
    ]);
    const root = await makeConn(f).ensureRoot("proj");
    expect(root.id).toBe("42");
    expect(root.parentId).toBe("8061115");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls[1].url).toContain("/rest/api/search?cql=");
  });

  it("ensureRoot creates folder under the space root, then the landing page inside it", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: { results: [] } },              // no folder yet
      { status: 200, body: { id: 555 } },                   // folder created
      { status: 200, body: { results: [] } },              // no landing yet
      { status: 200, body: rawPage({ id: 43, title: "proj", parentId: 555 }) },
    ]);
    const root = await makeConn(f).ensureRoot("proj");
    expect(root.id).toBe("43");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0].url).toContain("/api/v2/folders");
    expect(posts[0].body).toMatchObject({ spaceId: "111", title: "proj", parentId: "900" });
    expect(posts[1].url).toContain("/api/v2/pages");
    expect(posts[1].body).toMatchObject({ title: "proj", parentId: "555" });
  });
});

describe("ConfluenceConnector image attachments", () => {
  const img = { ref: "diagrams/x.png", filename: "x.png",
    data: Buffer.from([1, 2, 3]), mediaType: "image/png" };

  it("createPage with images uploads multipart with the nocheck header", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },                       // GET spaces
      { status: 200, body: rawPage({ id: 123 }) },        // POST pages
      { status: 200, body: { results: [] } },             // GET existing attachment by filename
      { status: 200, body: { results: [{ id: "att9" }] } }, // POST upload
    ]);
    await makeConn(f).createPage({ title: "T", markdown: "![m](diagrams/x.png)", images: [img] });
    expect(calls[2].url).toContain("/rest/api/content/123/child/attachment?filename=x.png");
    const upload = calls[3];
    expect(upload.url).toContain("/rest/api/content/123/child/attachment");
    expect(upload.method).toBe("POST");
    expect(upload.headers!["X-Atlassian-Token"]).toBe("nocheck");
    expect(upload.body).toBeInstanceOf(FormData);
    // page body converted the registered ref to a native attachment image
    expect(JSON.stringify(calls[1].body)).toContain("ri:attachment");
  });

  it("existing attachment with the same filename gets a data update, not a duplicate", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: rawPage({ id: 123 }) },
      { status: 200, body: { results: [{ id: "att7" }] } }, // exists
      { status: 200, body: {} },                            // POST .../att7/data
    ]);
    await makeConn(f).createPage({ title: "T", markdown: "![m](diagrams/x.png)", images: [img] });
    expect(calls[3].url).toContain("/child/attachment/att7/data");
  });

  it("a failed upload degrades with a warning — the page still publishes", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: SPACE },
      { status: 200, body: rawPage({ id: 123 }) },
      { status: 400, body: {} },                            // existing-check explodes
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await makeConn(f).createPage({ title: "T", markdown: "x", images: [img] });
    expect(page.id).toBe("123");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("ConfluenceConnector scoped-token gateway", () => {
  const GW_BASE = "https://x.atlassian.net/wiki";
  const SITE_ORIGIN = "https://x.atlassian.net";
  const CLOUD_ID = "cid-456";

  function makeGwConn(f: FetchLike, token: string, authMode?: "site" | "gateway") {
    return new ConfluenceConnector(
      { baseUrl: GW_BASE, spaceKey: "DOCS", emailEnv: "CONFLUENCE_EMAIL",
        tokenEnv: "CONFLUENCE_API_TOKEN", ...(authMode ? { authMode } : {}) },
      f,
      () => ({ email: "e@x.io", token }),
    );
  }

  it("ATCTT token resolves cloudId via unauthenticated tenant_info at the site origin (no /wiki), then routes API calls through the gateway with Basic auth", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { cloudId: CLOUD_ID } },
      { status: 200, body: rawPage() },
    ]);
    const t = makeGwConn(f, "ATCTTsecret");
    const page = await t.getPage("123");

    expect(calls[0].url).toBe(`${SITE_ORIGIN}/_edge/tenant_info`);
    expect(calls[0].auth).toBeUndefined();

    expect(calls[1].url).toBe(`https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/123`);
    expect(calls[1].auth).toBe(`Basic ${Buffer.from("e@x.io:ATCTTsecret").toString("base64")}`);

    // Human-facing link stays on the site host in gateway mode.
    expect(page.url).toBe(`${GW_BASE}/spaces/DOCS/pages/123/T`);
  });

  it("memoizes cloudId across multiple operations — tenant_info fetched exactly once", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { cloudId: CLOUD_ID } },
      { status: 200, body: rawPage() },
      { status: 200, body: rawPage() },
    ]);
    const t = makeGwConn(f, "ATCTTsecret");
    await t.getPage("123");
    await t.getPage("123");
    expect(calls.filter((c) => c.url.includes("/_edge/tenant_info")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("api.atlassian.com")).length).toBe(2);
  });

  it("classic token: zero behavior change — no tenant_info call, site routing as before", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: rawPage() }]);
    const t = makeGwConn(f, "classic-token-123");
    await t.getPage("123");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${GW_BASE}/api/v2/pages/123`);
  });

  it("attachment uploads route through the gateway too, sharing cloudId resolution with api()", async () => {
    const img = { ref: "diagrams/x.png", filename: "x.png",
      data: Buffer.from([1, 2, 3]), mediaType: "image/png" };
    const { f, calls } = fixtureFetch([
      { status: 200, body: { cloudId: CLOUD_ID } },
      { status: 200, body: SPACE },
      { status: 200, body: rawPage({ id: 123 }) },
      { status: 200, body: { results: [] } },
      { status: 200, body: { results: [{ id: "att9" }] } },
    ]);
    const t = makeGwConn(f, "ATCTTsecret");
    await t.createPage({ title: "T", markdown: "![m](diagrams/x.png)", images: [img] });
    const upload = calls.find((c) => c.method === "POST" && c.url.includes("/child/attachment") && !c.url.includes("filename="))!;
    expect(upload.url).toBe(`https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/rest/api/content/123/child/attachment`);
  });

  it('authMode: "site" forces site routing even with an ATCTT token', async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: rawPage() }]);
    const t = makeGwConn(f, "ATCTTsecret", "site");
    await t.getPage("123");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${GW_BASE}/api/v2/pages/123`);
  });
});
