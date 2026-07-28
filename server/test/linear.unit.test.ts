import { describe, it, expect, vi } from "vitest";
import { LinearTracker, configSchema, make } from "../src/tracker/adapters/linear.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records GraphQL calls; replies from a queue of canned {data}/{errors} bodies. */
function gqlFetch(fixtures: Array<unknown>) {
  const calls: Array<{ query: string; variables: Record<string, unknown>; headers: Headers }> = [];
  const f: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: body.query, variables: body.variables ?? {}, headers: new Headers(init?.headers) });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx), { status: 200 });
  };
  return { f, calls };
}

const TEAM = "team-uuid-1";
const t = (f: FetchLike) => new LinearTracker({ teamId: TEAM, apiKeyEnv: "LINEAR_API_KEY" }, f, () => "lin_key");

// Canned issue node in Linear's shape
const node = (over: Record<string, unknown> = {}) => ({
  id: "uuid-1", identifier: "ENG-1", title: "t", description: "b",
  url: "https://linear.app/acme/issue/ENG-1",
  updatedAt: "2026-07-28T00:00:00.000Z",
  state: { type: "backlog" },
  labels: { nodes: [] as Array<{ name: string }> },
  project: null,
  assignee: null,
  ...over,
});

const statesFixture = {
  data: { team: { states: { nodes: [
    { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
    { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "st-doing", name: "In Progress", type: "started", position: 2 },
    { id: "st-done", name: "Done", type: "completed", position: 3 },
  ] } } },
};

describe("LinearTracker mapping", () => {
  it("configSchema defaults apiKeyEnv to LINEAR_API_KEY", () => {
    const cfg = configSchema.parse({ teamId: TEAM });
    expect(cfg.apiKeyEnv).toBe("LINEAR_API_KEY");
  });

  it("make() throws AUTH_MISSING when the key env var is unset, before any HTTP call", async () => {
    const cfg = configSchema.parse({ teamId: TEAM });
    const prev = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    const { f, calls } = gqlFetch([]);
    try {
      const tracker = make(cfg, f);
      await expect(tracker.getIssue("ENG-1")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (prev !== undefined) process.env.LINEAR_API_KEY = prev;
    }
  });

  it("sends the API key raw in the authorization header (no Bearer)", async () => {
    const { f, calls } = gqlFetch([{ data: { issue: node() } }]);
    await t(f).getIssue("ENG-1");
    expect(calls[0].headers.get("authorization")).toBe("lin_key");
  });

  it("createIssue posts issueCreate with teamId/title/description and normalizes", async () => {
    const { f, calls } = gqlFetch([{ data: { issueCreate: { issue: node() } } }]);
    const issue = await t(f).createIssue({ title: "t", body: "b" });
    expect(calls[0].query).toContain("issueCreate");
    expect(calls[0].variables.input).toMatchObject({ teamId: TEAM, title: "t", description: "b" });
    expect(issue).toMatchObject({ id: "ENG-1", title: "t", body: "b", state: "open" });
  });

  it("createIssue with labels finds existing + creates missing, then passes labelIds", async () => {
    const { f, calls } = gqlFetch([
      { data: { team: { labels: { nodes: [{ id: "lb-bug", name: "bug" }] } } } },
      { data: { issueLabelCreate: { issueLabel: { id: "lb-new", name: "new-one" } } } },
      { data: { issueCreate: { issue: node({ labels: { nodes: [{ name: "bug" }, { name: "new-one" }] } }) } } },
    ]);
    const issue = await t(f).createIssue({ title: "t", labels: ["bug", "new-one"] });
    expect(calls[0].query).toContain("labels");
    expect(calls[1].query).toContain("issueLabelCreate");
    expect(calls[1].variables.input).toMatchObject({ name: "new-one", teamId: TEAM });
    expect(calls[2].variables.input).toMatchObject({ labelIds: ["lb-bug", "lb-new"] });
    expect(issue.labels).toEqual(["bug", "new-one"]);
  });

  it("createIssue with phase passes projectId", async () => {
    const { f, calls } = gqlFetch([
      { data: { issueCreate: { issue: node({ project: { id: "prj-1" } }) } } },
    ]);
    const issue = await t(f).createIssue({ title: "t", phase: "prj-1" });
    expect(calls[0].variables.input).toMatchObject({ projectId: "prj-1" });
    expect(issue.phase).toBe("prj-1");
  });

  it("getIssue maps state.type: started→in_progress, completed→closed, canceled→closed, backlog→open", async () => {
    for (const [type, want] of [
      ["started", "in_progress"], ["completed", "closed"],
      ["canceled", "closed"], ["backlog", "open"], ["unstarted", "open"],
    ] as const) {
      const { f } = gqlFetch([{ data: { issue: node({ state: { type } }) } }]);
      expect((await t(f).getIssue("ENG-1")).state).toBe(want);
    }
  });

  it("updateIssue(state) resolves the team stateId once and caches it", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node({ state: { type: "started" } }) } } },
      { data: { issueUpdate: { issue: node({ state: { type: "completed" } }) } } },
    ]);
    const tracker = t(f);
    const first = await tracker.updateIssue("ENG-1", { state: "in_progress" });
    expect(first.state).toBe("in_progress");
    expect(calls[1].variables).toMatchObject({ id: "ENG-1", input: { stateId: "st-doing" } });
    await tracker.updateIssue("ENG-1", { state: "closed" });
    // second state write reuses the cached states — exactly 3 calls total
    expect(calls).toHaveLength(3);
    expect(calls[2].variables).toMatchObject({ input: { stateId: "st-done" } });
  });

  it("updateIssue(state: open) prefers the unstarted state over backlog", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node() } } },
    ]);
    await t(f).updateIssue("ENG-1", { state: "open" });
    expect(calls[1].variables).toMatchObject({ input: { stateId: "st-todo" } });
  });

  it("updateIssue(labels) replaces the full label set via labelIds", async () => {
    const { f, calls } = gqlFetch([
      { data: { team: { labels: { nodes: [{ id: "lb-bug", name: "bug" }] } } } },
      { data: { issueUpdate: { issue: node({ labels: { nodes: [{ name: "bug" }] } }) } } },
    ]);
    await t(f).updateIssue("ENG-1", { labels: ["bug"] });
    expect(calls[1].variables).toMatchObject({ input: { labelIds: ["lb-bug"] } });
  });

  it("closeIssue writes the completed stateId", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node({ state: { type: "completed" } }) } } },
    ]);
    const issue = await t(f).closeIssue("ENG-1");
    expect(calls[1].variables).toMatchObject({ input: { stateId: "st-done" } });
    expect(issue.state).toBe("closed");
  });

  it("listIssues filters by team; phase adds a project filter; state filters client-side", async () => {
    const { f, calls } = gqlFetch([
      { data: { issues: { nodes: [
        node({ identifier: "ENG-1", state: { type: "backlog" } }),
        node({ identifier: "ENG-2", state: { type: "completed" } }),
      ] } } },
    ]);
    const issues = await t(f).listIssues({ state: "open" });
    expect((calls[0].variables.filter as Record<string, unknown>).team)
      .toEqual({ id: { eq: TEAM } });
    expect(issues.map((i) => i.id)).toEqual(["ENG-1"]);

    const { f: f2, calls: calls2 } = gqlFetch([{ data: { issues: { nodes: [] } } }]);
    await t(f2).listIssues({ phase: "prj-1" });
    expect((calls2[0].variables.filter as Record<string, unknown>).project)
      .toEqual({ id: { eq: "prj-1" } });
  });

  it("listIssues warns on truncation at the 100-item cap", async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => node({ identifier: `ENG-${i}` }));
    const { f } = gqlFetch([{ data: { issues: { nodes } } }]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = await t(f).listIssues();
    expect(issues).toHaveLength(100);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("GraphQL errors map to typed CairnErrors: entity-not-found → NOT_FOUND, else TRACKER_DOWN", async () => {
    const { f } = gqlFetch([{ errors: [{ message: "Entity not found: Issue" }] }]);
    await expect(t(f).getIssue("ENG-404")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { f: f2 } = gqlFetch([{ errors: [{ message: "something exploded" }] }]);
    await expect(t(f2).getIssue("ENG-1")).rejects.toMatchObject({ code: "TRACKER_DOWN" });
  });
});
