import { describe, it, expect, vi } from "vitest";
import { JiraTracker } from "../src/tracker/adapters/jira.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const BASE = "https://o.atlassian.net";

const cfg = {
  baseUrl: BASE,
  projectKey: "CHN",
  issueType: "Task",
  emailEnv: "JIRA_EMAIL",
  tokenEnv: "JIRA_API_TOKEN",
  transitions: { in_progress: "In Progress", closed: "Done" },
};

const adfBody = (text: string) => ({
  type: "doc", version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: "CHN-101",
  fields: {
    summary: "t",
    description: adfBody("b"),
    status: { statusCategory: { key: "new" } },
    updated: "2026-07-12T00:00:00.000+0000",
    labels: ["cairn-test"],
    parent: undefined,
    ...over,
  },
});

describe("JiraTracker mapping", () => {
  it("createIssue POSTs an ADF-wrapped body to /rest/api/3/issue", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-101" } },
      { status: 200, body: jiraIssue() },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/issue`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({
      fields: {
        project: { key: "CHN" },
        summary: "t",
        description: adfBody("b"),
        issuetype: { name: "Task" },
      },
    });
    expect(issue.id).toBe("CHN-101");
  });

  it("createIssue with phase sets fields.parent = { key }", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-102" } },
      { status: 200, body: jiraIssue({ key: "CHN-102" }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.createIssue({ title: "t", phase: "CHN-1" });
    expect(calls[0].body).toMatchObject({ fields: { parent: { key: "CHN-1" } } });
  });

  it("sends Basic auth header base64(email:token)", async () => {
    let auth = "";
    const f: FetchLike = async (_u, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(jiraIssue()), { status: 200 });
    };
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.getIssue("CHN-101");
    const expected = "Basic " + Buffer.from("e@x.com:tok").toString("base64");
    expect(auth).toBe(expected);
  });

  it.each([
    ["new", "open"],
    ["indeterminate", "in_progress"],
    ["done", "closed"],
  ] as const)("statusCategory.key=%s maps to state=%s", async (cat, expected) => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: cat } } }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.state).toBe(expected);
  });

  it("getIssue extracts plain text from ADF description recursively", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ description: adfBody("hello world") }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.body).toContain("hello world");
  });

  it("updateIssue(state=in_progress) does GET transitions then POSTs matching id", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          transitions: [
            { id: "11", name: "Start Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "indeterminate" } } }) }, // GET after
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.updateIssue("CHN-101", { state: "in_progress" });

    const getTransitionsCall = calls.find((c) => c.method === "GET" && c.url.includes("/transitions"));
    expect(getTransitionsCall).toBeDefined();
    const postTransitionCall = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(postTransitionCall!.body).toMatchObject({ transition: { id: "11" } });
  });

  it("updateIssue(state=open) from in_progress transitions to a status whose category is 'new'", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          transitions: [
            { id: "11", name: "Start Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "31", name: "To Do", to: { name: "To Do", statusCategory: { key: "new" } } },
            { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "new" } } }) }, // GET after
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.updateIssue("CHN-101", { state: "open" });

    const postTransitionCall = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(postTransitionCall!.body).toMatchObject({ transition: { id: "31" } });
  });

  it("closeIssue transitions to the configured closed transition name", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          transitions: [
            { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "done" } } }) }, // GET after
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const closed = await t.closeIssue("CHN-101");
    const postTransitionCall = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(postTransitionCall!.body).toMatchObject({ transition: { id: "21" } });
    expect(closed.state).toBe("closed");
  });

  it("updateIssue logs (does not throw) when no matching transition is found", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: { transitions: [{ id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } }] },
      },
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "new" } } }) }, // GET after (no transition POSTed)
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await expect(t.updateIssue("CHN-101", { state: "in_progress" })).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("CHN-101"));
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/transitions"))).toBe(false);
    spy.mockRestore();
  });

  it("listIssues(phase) POSTs a JQL search with parent = <KEY> and maxResults 100", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue()] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issues = await t.listIssues({ phase: "CHN-1" });
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/search`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ jql: "parent = CHN-1", maxResults: 100 });
    expect(issues).toHaveLength(1);
  });

  it("listIssues() without a phase excludes epics from the JQL (epics are phases, not issues)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue()] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.listIssues();
    expect(calls[0].body).toMatchObject({ jql: "project = CHN AND issuetype != Epic" });
  });

  it("listIssues(phase) does NOT add the epic-exclusion clause (parent filter already excludes epics)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue()] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.listIssues({ phase: "CHN-1" });
    expect(calls[0].body).toMatchObject({ jql: "parent = CHN-1" });
  });

  it("listIssues warns via console.error when results are truncated at the 100 cap", async () => {
    const many = Array.from({ length: 100 }, (_, i) => jiraIssue({ key: `CHN-${i}` }));
    const { f } = fixtureFetch([
      { status: 200, body: { issues: many, total: 250 } },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issues = await t.listIssues();
    expect(issues).toHaveLength(100);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("createPhase creates an Epic-typed issue", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-1" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const phase = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/issue`);
    expect(calls[0].body).toMatchObject({
      fields: { issuetype: { name: "Epic" }, summary: "Phase 1", project: { key: "CHN" } },
    });
    expect(phase).toMatchObject({ id: "CHN-1", name: "Phase 1" });
  });

  it("listPhases JQL-searches for issuetype = Epic", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue({ key: "CHN-1", summary: "Phase 1" })] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.listPhases();
    expect(calls[0].body).toMatchObject({ jql: expect.stringContaining("issuetype = Epic") });
  });

  it("normalizes Jira's +0000 offset timestamps to valid ISO-8601", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ updated: "2026-07-12T10:30:00.000+0000" }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.updatedAt).toBe("2026-07-12T10:30:00.000+00:00");
    expect(Number.isNaN(Date.parse(issue.updatedAt))).toBe(false);
  });

  it("rejects malformed issue ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await expect(t.getIssue("not-a-key!!")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("rejects a non-key phase filter before any HTTP (JQL injection guard)", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await expect(t.listIssues({ phase: "CHN-1 OR project = X" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("throws AUTH_MISSING with zero HTTP calls when email/token env vars are absent", async () => {
    const { f, calls } = fixtureFetch([]);
    const original = { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    try {
      const { make } = await import("../src/tracker/adapters/jira.js");
      const t = make(cfg, f);
      await expect(t.getIssue("CHN-101")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (original.email !== undefined) process.env.JIRA_EMAIL = original.email;
      if (original.token !== undefined) process.env.JIRA_API_TOKEN = original.token;
    }
  });
});
