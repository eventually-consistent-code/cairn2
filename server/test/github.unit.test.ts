import { describe, it, expect } from "vitest";
import { GitHubTracker } from "../src/tracker/adapters/github.js";
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

const ghIssue = (over: Record<string, unknown> = {}) => ({
  number: 7, title: "t", body: "b", state: "open",
  labels: [{ name: "cairn-test" }], milestone: null, assignee: null,
  updated_at: "2026-07-12T00:00:00Z", html_url: "https://github.com/o/r/issues/7",
  ...over,
});

describe("GitHubTracker mapping", () => {
  it("createIssue POSTs to /repos/{repo}/issues and normalizes", async () => {
    const { f, calls } = fixtureFetch([{ status: 201, body: ghIssue() }]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(issue).toMatchObject({ id: "7", state: "open", labels: ["cairn-test"] });
  });

  it("in-progress label maps to state=in_progress on read", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [{ name: "in-progress" }] }) },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    expect((await t.getIssue("7")).state).toBe("in_progress");
  });

  it("in_progress without explicit labels preserves the issue's existing labels", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [{ name: "priority-high" }] }) }, // GET current
      { status: 200, body: ghIssue({ labels: [{ name: "priority-high" }, { name: "in-progress" }] }) }, // PATCH
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await t.updateIssue("7", { state: "in_progress" });
    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.body.labels).toEqual(expect.arrayContaining(["priority-high", "in-progress"]));
  });

  it("updateIssue(state=in_progress) adds the label; closed sets state", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [] }) }, // GET current (no existing labels)
      { status: 200, body: ghIssue({ labels: [{ name: "in-progress" }] }) }, // PATCH
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await t.updateIssue("7", { state: "in_progress" });
    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.body).toMatchObject({ labels: ["in-progress"] });

    const { f: f2, calls: c2 } = fixtureFetch([
      { status: 200, body: ghIssue({ state: "closed" }) },
    ]);
    const t2 = new GitHubTracker({ repo: "o/r" }, f2, () => "tok");
    const closed = await t2.closeIssue("7");
    expect(c2[0].body).toMatchObject({ state: "closed" });
    expect(closed.state).toBe("closed");
  });

  it("updateIssue(state=open) strips the in-progress label but keeps others", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: ghIssue({ labels: [{ name: "in-progress" }, { name: "priority-high" }] }) }, // GET current
      { status: 200, body: ghIssue({ labels: [{ name: "priority-high" }], state: "open" }) }, // PATCH
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    await t.updateIssue("7", { state: "open" });
    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect(patchCall.body).toMatchObject({ state: "open" });
    expect(patchCall.body.labels).toContain("priority-high");
    expect(patchCall.body.labels).not.toContain("in-progress");
  });

  it("createPhase POSTs a milestone; listIssues filters by milestone", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { number: 2, title: "Phase 1", state: "open" } },
      { status: 200, body: [ghIssue({ milestone: { number: 2, title: "Phase 1" } })] },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const ph = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/milestones");
    expect(ph).toMatchObject({ id: "2", name: "Phase 1" });
    const issues = await t.listIssues({ phase: "2" });
    expect(calls[1].url).toContain("milestone=2");
    expect(issues[0].phase).toBe("2");
  });

  it("sends token as Bearer auth header", async () => {
    let auth = "";
    const f: FetchLike = async (_u, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(ghIssue()), { status: 200 });
    };
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok123");
    await t.getIssue("7");
    expect(auth).toBe("Bearer tok123");
  });
});
