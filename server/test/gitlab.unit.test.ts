import { describe, it, expect, afterEach, vi } from "vitest";
import { GitLabTracker } from "../src/tracker/adapters/gitlab.js";
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

const glIssue = (over: Record<string, unknown> = {}) => ({
  iid: 7, title: "t", description: "b", state: "opened",
  labels: ["cairn-test"], milestone: null, assignee: null,
  updated_at: "2026-07-12T00:00:00Z", web_url: "https://gitlab.com/o/r/issues/7",
  ...over,
});

const baseCfg = { baseUrl: "https://gitlab.com", project: "o/r", tokenEnv: "GITLAB_TOKEN", extraLabels: [] };

describe("GitLabTracker mapping", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createIssue POSTs to /projects/{project}/issues and normalizes", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([{ status: 201, body: glIssue() }]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(calls[0].url).toBe("https://gitlab.com/api/v4/projects/o%2Fr/issues");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ title: "t", description: "b", labels: "cairn-test" });
    expect(calls[0].headers?.get("PRIVATE-TOKEN")).toBe("tok");
    expect(issue).toMatchObject({ id: "7", state: "open", labels: ["cairn-test"] });
  });

  it("createIssue with phase sets milestone_id (numeric phase)", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 201, body: glIssue({ milestone: { id: 3 } }) },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.createIssue({ title: "t", phase: "3" });
    expect(calls[0].body).toMatchObject({ milestone_id: 3 });
    expect(issue.phase).toBe("3");
  });

  it("createIssue without phase omits milestone_id", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([{ status: 201, body: glIssue() }]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.createIssue({ title: "t" });
    expect(calls[0].body).not.toHaveProperty("milestone_id");
    expect(issue.phase).toBeUndefined();
  });

  it("createIssue throws CONFIG_INVALID on non-numeric phase, zero HTTP calls", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([]);
    const t = new GitLabTracker(baseCfg, f);
    await expect(t.createIssue({ title: "x", phase: "nope" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls.length).toBe(0);
  });

  it("getIssue GETs /projects/{project}/issues/:iid and maps state=opened -> open", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([{ status: 200, body: glIssue() }]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.getIssue("7");
    expect(calls[0].url).toBe("https://gitlab.com/api/v4/projects/o%2Fr/issues/7");
    expect(calls[0].method).toBe("GET");
    expect(issue.state).toBe("open");
  });

  it("getIssue maps state=closed -> closed", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f } = fixtureFetch([{ status: 200, body: glIssue({ state: "closed" }) }]);
    const t = new GitLabTracker(baseCfg, f);
    expect((await t.getIssue("7")).state).toBe("closed");
  });

  it("in-progress label maps to state=in_progress on read", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f } = fixtureFetch([
      { status: 200, body: glIssue({ labels: ["in-progress"] }) },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.getIssue("7");
    expect(issue.state).toBe("in_progress");
    expect(issue.labels).not.toContain("in-progress");
  });

  it("rejects non-numeric issue ids before any HTTP call", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([]);
    const t = new GitLabTracker(baseCfg, f);
    await expect(t.getIssue("7/notes")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("updateIssue(state=in_progress) fetch-then-merges the WIP label", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 200, body: glIssue({ labels: ["priority-high"] }) }, // GET current
      { status: 200, body: glIssue({ labels: ["priority-high", "in-progress"] }) }, // PUT
    ]);
    const t = new GitLabTracker(baseCfg, f);
    await t.updateIssue("7", { state: "in_progress" });
    const putCall = calls[calls.length - 1];
    expect(putCall.method).toBe("PUT");
    expect(putCall.url).toBe("https://gitlab.com/api/v4/projects/o%2Fr/issues/7");
    const labels = String(putCall.body.labels).split(",");
    expect(labels).toEqual(expect.arrayContaining(["priority-high", "in-progress"]));
  });

  it("updateIssue(state=open) strips the WIP label but keeps others", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 200, body: glIssue({ labels: ["in-progress", "priority-high"] }) }, // GET current
      { status: 200, body: glIssue({ labels: ["priority-high"] }) }, // PUT
    ]);
    const t = new GitLabTracker(baseCfg, f);
    await t.updateIssue("7", { state: "open" });
    const putCall = calls[calls.length - 1];
    expect(putCall.method).toBe("PUT");
    const labels = String(putCall.body.labels).split(",").filter(Boolean);
    expect(labels).toContain("priority-high");
    expect(labels).not.toContain("in-progress");
    expect(putCall.body).not.toHaveProperty("state_event");
  });

  it("updateIssue(state=closed) sends state_event=close", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 200, body: glIssue({ state: "closed" }) },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.updateIssue("7", { state: "closed" });
    expect(calls[0].body).toMatchObject({ state_event: "close" });
    expect(issue.state).toBe("closed");
  });

  it("closeIssue delegates to updateIssue(state=closed)", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 200, body: glIssue({ state: "closed" }) },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const issue = await t.closeIssue("7");
    expect(calls[0].body).toMatchObject({ state_event: "close" });
    expect(issue.state).toBe("closed");
  });

  it("listIssues paginates and filters by phase client-side", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 200, body: [
        glIssue({ iid: 7, milestone: { id: 2 } }),
        glIssue({ iid: 9, milestone: null }),
      ] },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const issues = await t.listIssues({ phase: "2" });
    expect(calls[0].url).toContain("/projects/o%2Fr/issues?per_page=100&state=all");
    expect(calls[0].method).toBe("GET");
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("7");
    expect(issues[0].phase).toBe("2");
  });

  it("listIssues filters by state client-side", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f } = fixtureFetch([
      { status: 200, body: [
        glIssue({ iid: 7, state: "closed" }),
        glIssue({ iid: 9, state: "opened" }),
      ] },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const issues = await t.listIssues({ state: "closed" });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("7");
  });

  it("createPhase POSTs to /projects/{project}/milestones", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 201, body: { id: 2, title: "Phase 1", state: "active" } },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const ph = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe("https://gitlab.com/api/v4/projects/o%2Fr/milestones");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ title: "Phase 1" });
    expect(ph).toMatchObject({ id: "2", name: "Phase 1", state: "open" });
  });

  it("listPhases GETs /projects/{project}/milestones?state=all", async () => {
    vi.stubEnv("GITLAB_TOKEN", "tok");
    const { f, calls } = fixtureFetch([
      { status: 200, body: [
        { id: 2, title: "Phase 1", state: "active" },
        { id: 3, title: "Phase 2", state: "closed" },
      ] },
    ]);
    const t = new GitLabTracker(baseCfg, f);
    const phases = await t.listPhases();
    expect(calls[0].url).toContain("/projects/o%2Fr/milestones?state=all");
    expect(phases).toEqual([
      { id: "2", name: "Phase 1", state: "open" },
      { id: "3", name: "Phase 2", state: "closed" },
    ]);
  });

  it("missing token env throws AUTH_MISSING with zero HTTP calls", async () => {
    vi.stubEnv("GITLAB_TOKEN", "");
    delete process.env.GITLAB_TOKEN;
    const { f, calls } = fixtureFetch([]);
    const t = new GitLabTracker(baseCfg, f);
    await expect(t.getIssue("7")).rejects.toMatchObject({ code: "AUTH_MISSING" });
    expect(calls.length).toBe(0);
  });
});
