import { describe, it, expect } from "vitest";
import { AzureBoardsTracker } from "../src/tracker/adapters/azure-boards.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const cfg = {
  orgUrl: "https://dev.azure.com/org",
  project: "Proj",
  workItemType: "Issue",
  patEnv: "AZURE_DEVOPS_PAT",
  apiVersion: "7.0",
  states: { in_progress: "Doing", closed: "Done", open: "To Do" },
};

const wi = (over: Record<string, unknown> = {}) => ({
  id: 7,
  fields: {
    "System.Title": "t",
    "System.Description": "b",
    "System.State": "To Do",
    "System.Tags": "cairn-test",
    "System.ChangedDate": "2026-07-12T00:00:00Z",
    ...(over.fields as Record<string, unknown> | undefined),
  },
  url: "https://dev.azure.com/org/Proj/_apis/wit/workitems/7",
  ...over,
});

describe("AzureBoardsTracker mapping", () => {
  it("createIssue POSTs json-patch to workitems/$type with api-version and Basic-PAT auth", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: wi() }]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/Proj/_apis/wit/workitems/%24Issue");
    expect(calls[0].url).toContain("api-version=7.0");
    expect(calls[0].headers.get("content-type")).toBe("application/json-patch+json");
    expect(calls[0].headers.get("authorization")).toBe(
      `Basic ${Buffer.from(":pat123").toString("base64")}`,
    );
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.Title", value: "t" },
        { op: "add", path: "/fields/System.Description", value: "b" },
        { op: "add", path: "/fields/System.Tags", value: "cairn-test" },
      ]),
    );
    expect(issue).toMatchObject({ id: "7", title: "t", state: "open", labels: ["cairn-test"] });
  });

  it("createIssue with phase adds System.IterationPath op using the stored id->path map", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "Sprint 1", path: "Proj\\Sprint 1" }] } },
      { status: 200, body: wi() },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.listPhases(); // populate id->path map
    await t.createIssue({ title: "t", phase: "guid-1" });
    const createCall = calls[calls.length - 1];
    expect(createCall.body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.IterationPath", value: "Proj\\Sprint 1" },
      ]),
    );
  });

  it("getIssue normalizes state via StateCategory when present", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "InProgress" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    expect((await t.getIssue("7")).state).toBe("in_progress");
  });

  it("getIssue falls back to states map when StateCategory absent", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "Done" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    expect((await t.getIssue("7")).state).toBe("closed");
  });

  it("StateCategory Completed/Removed -> closed, Proposed -> open", async () => {
    const { f: f1 } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "Completed" } }) },
    ]);
    const t1 = new AzureBoardsTracker(cfg, f1, () => "pat123");
    expect((await t1.getIssue("7")).state).toBe("closed");

    const { f: f2 } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "Removed" } }) },
    ]);
    const t2 = new AzureBoardsTracker(cfg, f2, () => "pat123");
    expect((await t2.getIssue("7")).state).toBe("closed");

    const { f: f3 } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "Proposed" } }) },
    ]);
    const t3 = new AzureBoardsTracker(cfg, f3, () => "pat123");
    expect((await t3.getIssue("7")).state).toBe("open");
  });

  it("updateIssue(state=in_progress) PATCHes System.State to states.in_progress", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "Doing" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.updateIssue("7", { state: "in_progress" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/Proj/_apis/wit/workitems/7");
    expect(calls[0].url).toContain("api-version=7.0");
    expect(calls[0].headers.get("content-type")).toBe("application/json-patch+json");
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.State", value: "Doing" },
      ]),
    );
  });

  it("updateIssue(state=open) PATCHes System.State back to states.open default 'To Do'", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "To Do" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.updateIssue("7", { state: "open" });
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.State", value: "To Do" },
      ]),
    );
  });

  it("closeIssue PATCHes System.State to states.closed", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "Done" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.closeIssue("7");
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.State", value: "Done" },
      ]),
    );
  });

  it("labels: System.Tags splits on '; ' for read and joins with '; ' for write", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.Tags": "alpha; beta; gamma" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const issue = await t.getIssue("7");
    expect(issue.labels).toEqual(["alpha", "beta", "gamma"]);

    const { f: f2, calls } = fixtureFetch([{ status: 200, body: wi() }]);
    const t2 = new AzureBoardsTracker(cfg, f2, () => "pat123");
    await t2.createIssue({ title: "t", labels: ["alpha", "beta"] });
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.Tags", value: "alpha; beta" },
      ]),
    );
  });

  it("listIssues(phase) runs WIQL then batch-fetches ids, escaping single quotes in the iteration path", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "O'Brien's Sprint", path: "Proj\\O'Brien's Sprint" }] } },
      { status: 200, body: { workItems: [{ id: 7 }, { id: 8 }] } },
      { status: 200, body: { value: [wi({ id: 7 }), wi({ id: 8 })] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.listPhases();
    const issues = await t.listIssues({ phase: "guid-1" });

    const wiqlCall = calls[1];
    expect(wiqlCall.method).toBe("POST");
    expect(wiqlCall.url).toContain("/_apis/wit/wiql");
    expect(wiqlCall.url).toContain("api-version=7.0");
    expect(wiqlCall.body.query).toContain("[System.IterationPath] = 'Proj\\O''Brien''s Sprint'");

    const batchCall = calls[2];
    expect(batchCall.url).toContain("/_apis/wit/workitems?");
    expect(batchCall.url).toContain("ids=7%2C8");
    expect(issues).toHaveLength(2);
  });

  it("listIssues caps at 100 ids and logs a truncation warning", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const { f } = fixtureFetch([
      { status: 200, body: { workItems: ids.map((id) => ({ id })) } },
      { status: 200, body: { value: ids.slice(0, 100).map((id) => wi({ id })) } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const errSpy: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errSpy.push(msg);
    try {
      const issues = await t.listIssues();
      expect(issues).toHaveLength(100);
      expect(errSpy.some((m) => m.includes("truncat"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("createPhase POSTs classificationnodes/iterations and returns id=identifier GUID, name kept", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { identifier: "guid-2", name: "Sprint 2" } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const ph = await t.createPhase("Sprint 2");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/_apis/wit/classificationnodes/iterations");
    expect(calls[0].url).toContain("api-version=7.0");
    expect(calls[0].body).toMatchObject({ name: "Sprint 2" });
    expect(ph).toMatchObject({ id: "guid-2", name: "Sprint 2" });
  });

  it("listPhases GETs classificationnodes/iterations with $depth and maps identifier/name", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "Sprint 1" }, { identifier: "guid-2", name: "Sprint 2" }] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const phases = await t.listPhases();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/_apis/wit/classificationnodes/iterations");
    expect(phases).toEqual([
      { id: "guid-1", name: "Sprint 1", state: "open" },
      { id: "guid-2", name: "Sprint 2", state: "open" },
    ]);
  });

  it("rejects non-numeric work item ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await expect(t.getIssue("7/comments")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("missing PAT env throws AUTH_MISSING with zero HTTP calls", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new AzureBoardsTracker(cfg, f, () => {
      throw new Error("should not be reached in this path — use default token resolver");
    });
    const prevEnv = process.env.AZURE_DEVOPS_PAT;
    delete process.env.AZURE_DEVOPS_PAT;
    try {
      const noTokenTracker = new AzureBoardsTracker(cfg, f);
      await expect(noTokenTracker.getIssue("7")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (prevEnv !== undefined) process.env.AZURE_DEVOPS_PAT = prevEnv;
    }
  });

  it("getIssue self-heals phase lookup on cold phasePaths map (no prior listPhases call)", async () => {
    // COLD map scenario: work item assigned to "Proj\\Sprint 9" iteration by another session.
    // The map is empty. getIssue should:
    // 1. Fetch the work item (IterationPath = "Proj\\Sprint 9")
    // 2. Call listPhases to populate the map (finds "Sprint 9" with id guid-sprint-9)
    // 3. Rescan and resolve phase = guid-sprint-9
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.IterationPath": "Proj\\Sprint 9" } }) },
      { status: 200, body: { value: [{ identifier: "guid-sprint-9", name: "Sprint 9", path: "Proj\\Sprint 9" }] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    // Do NOT call listPhases — map is cold
    const issue = await t.getIssue("7");
    expect(issue.phase).toBe("guid-sprint-9");
    // Verify both API calls happened in order: GET work item, then GET classificationnodes
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/workitems/7");
    expect(calls[1].url).toContain("/classificationnodes/iterations");
  });
});
