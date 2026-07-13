import { describe, it, expect, vi } from "vitest";
import { AsanaTracker, configSchema, make } from "../src/tracker/adapters/asana.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; headers?: Headers }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

// Asana wraps every payload in { data: ... }
const asanaTask = (over: Record<string, unknown> = {}) => ({
  data: {
    gid: "1207", name: "t", notes: "b", completed: false,
    modified_at: "2026-07-12T00:00:00Z",
    memberships: [],
    ...over,
  },
});

const asanaSection = (over: Record<string, unknown> = {}) => ({
  data: { gid: "5001", name: "Phase 1", ...over },
});

describe("AsanaTracker mapping", () => {
  it("createIssue POSTs to /tasks, unwraps .data, and normalizes", async () => {
    const { f, calls } = fixtureFetch([{ status: 201, body: asanaTask() }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issue = await t.createIssue({ title: "t", body: "b" });
    expect(calls[0].url).toBe("https://app.asana.com/api/1.0/tasks");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({
      data: { name: "t", notes: "b", projects: ["999"] },
    });
    expect(issue).toMatchObject({ id: "1207", title: "t", body: "b", state: "open" });
  });

  it("createIssue with phase creates the task then addTask's it to the section (two-call sequence)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: asanaTask({ gid: "1207" }) }, // POST /tasks
      { status: 200, body: { data: {} } }, // POST /sections/{gid}/addTask
    ]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issue = await t.createIssue({ title: "t", phase: "5001" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://app.asana.com/api/1.0/tasks");
    expect(calls[0].method).toBe("POST");
    expect(calls[1].url).toBe("https://app.asana.com/api/1.0/sections/5001/addTask");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toMatchObject({ data: { task: "1207" } });
    expect(issue.id).toBe("1207");
  });

  it("createIssue without phase does not call addTask", async () => {
    const { f, calls } = fixtureFetch([{ status: 201, body: asanaTask() }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    await t.createIssue({ title: "t" });
    expect(calls).toHaveLength(1);
  });

  it("getIssue maps completed:false -> open, completed:true -> closed", async () => {
    const { f: fOpen } = fixtureFetch([{ status: 200, body: asanaTask({ completed: false }) }]);
    const tOpen = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, fOpen, () => "tok");
    expect((await tOpen.getIssue("1207")).state).toBe("open");

    const { f: fClosed } = fixtureFetch([{ status: 200, body: asanaTask({ completed: true }) }]);
    const tClosed = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, fClosed, () => "tok");
    expect((await tClosed.getIssue("1207")).state).toBe("closed");
  });

  it("rejects non-numeric task ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    await expect(t.getIssue("abc")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("updateIssue(state=in_progress) degrades to open (completed:false), never writes closed", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: asanaTask({ completed: false }) }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issue = await t.updateIssue("1207", { state: "in_progress" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({ data: { completed: false } });
    expect(issue.state).toBe("open");
  });

  it("updateIssue(state=open) sets completed:false", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: asanaTask({ completed: false }) }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issue = await t.updateIssue("1207", { state: "open" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({ data: { completed: false } });
    expect(issue.state).toBe("open");
  });

  it("updateIssue(state=closed) sets completed:true", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: asanaTask({ completed: true }) }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issue = await t.updateIssue("1207", { state: "closed" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({ data: { completed: true } });
    expect(issue.state).toBe("closed");
  });

  it("closeIssue PUTs completed:true", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: asanaTask({ completed: true }) }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issue = await t.closeIssue("1207");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({ data: { completed: true } });
    expect(issue.state).toBe("closed");
  });

  it("sends token as Bearer auth header", async () => {
    let auth = "";
    const f: FetchLike = async (_u, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(asanaTask()), { status: 200 });
    };
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok123");
    await t.getIssue("1207");
    expect(auth).toBe("Bearer tok123");
  });

  it("listIssues(phase) GETs /sections/{gid}/tasks with opt_fields", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { data: [asanaTask().data] } }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issues = await t.listIssues({ phase: "5001" });
    expect(calls[0].url).toBe(
      "https://app.asana.com/api/1.0/sections/5001/tasks?opt_fields=name,notes,completed,modified_at,memberships.section.gid",
    );
    expect(calls[0].method).toBe("GET");
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("1207");
  });

  it("listIssues() without phase GETs /projects/{gid}/tasks with opt_fields", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { data: [asanaTask().data] } }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issues = await t.listIssues();
    expect(calls[0].url).toBe(
      "https://app.asana.com/api/1.0/projects/999/tasks?opt_fields=name,notes,completed,modified_at,memberships.section.gid&limit=100",
    );
    expect(calls[0].method).toBe("GET");
    expect(issues).toHaveLength(1);
  });

  it("listIssues() derives phase from memberships.section.gid", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: { data: [asanaTask({ memberships: [{ section: { gid: "5001" } }] }).data] } },
    ]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const issues = await t.listIssues();
    expect(issues[0].phase).toBe("5001");
  });

  it("listIssues warns on truncation when exactly at the 100-item cap", async () => {
    const items = Array.from({ length: 100 }, (_, i) => asanaTask({ gid: String(i) }).data);
    const { f } = fixtureFetch([{ status: 200, body: { data: items } }]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = await t.listIssues();
    expect(issues).toHaveLength(100);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("createPhase POSTs /projects/{gid}/sections; listPhases GETs /projects/{gid}/sections", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: asanaSection() },
      { status: 200, body: { data: [asanaSection().data] } },
    ]);
    const t = new AsanaTracker({ projectGid: "999", tokenEnv: "ASANA_TOKEN" }, f, () => "tok");
    const ph = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe("https://app.asana.com/api/1.0/projects/999/sections");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ data: { name: "Phase 1" } });
    expect(ph).toMatchObject({ id: "5001", name: "Phase 1", state: "open" });

    const phases = await t.listPhases();
    expect(calls[1].url).toBe("https://app.asana.com/api/1.0/projects/999/sections");
    expect(calls[1].method).toBe("GET");
    expect(phases).toEqual([{ id: "5001", name: "Phase 1", state: "open" }]);
  });

  it("make() throws AUTH_MISSING when the token env var is unset, before any HTTP call", async () => {
    const config = configSchema.parse({ projectGid: "999" });
    const prev = process.env.ASANA_TOKEN;
    delete process.env.ASANA_TOKEN;
    const calls: unknown[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    try {
      const tracker = make(config, f);
      await expect(tracker.getIssue("1207")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (prev !== undefined) process.env.ASANA_TOKEN = prev;
    }
  });

  it("configSchema defaults tokenEnv to ASANA_TOKEN", () => {
    const cfg = configSchema.parse({ projectGid: "999" });
    expect(cfg.tokenEnv).toBe("ASANA_TOKEN");
  });
});
