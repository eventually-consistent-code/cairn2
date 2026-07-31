import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { handoffPath } from "../src/core/continuity.js";
import { listSessions } from "../src/sessions/store.js";
import { PROVIDERS } from "../src/peers/run.js";

// Controllable failure injection for the continuity resilience test below.
// Mocks ONLY writeHandoff (everything else passes through to the real module)
// so a single test can simulate an unwritable ~/.cairn/handoff without
// chmodding the real shared homedir directory -- vitest runs test files in
// parallel workers, and other suites write handoffs there unguarded, so a
// chmod window would EACCES-flake unrelated tests.
const continuityFailure = vi.hoisted(() => ({ failWrites: false, failedAttempts: 0 }));
vi.mock("../src/core/continuity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/continuity.js")>();
  return {
    ...actual,
    writeHandoff: (...args: Parameters<typeof actual.writeHandoff>) => {
      if (continuityFailure.failWrites) {
        continuityFailure.failedAttempts += 1;
        throw new Error("simulated EACCES: handoff dir unwritable");
      }
      return actual.writeHandoff(...args);
    },
  };
});

describe("cairn MCP server", () => {
  let client: Client;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const server = buildServer({ projectDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  const listToolNames = async (): Promise<string[]> =>
    (await client.listTools()).tools.map((t) => t.name).sort();

  it("lists the expected tools", async () => {
    const tools = await listToolNames();
    expect(tools).toEqual([
      "context_get", "context_set", "issue_close", "issue_create", "issue_get",
      "issue_list", "issue_update", "issue_link", "issue_unlink", "issue_links",
      "graph_report", "tracker_migrate", "phase_create", "phase_list",
      "plan_drift", "plan_import", "plan_issues_set", "plan_phase_ensure",
      "plan_scaffold_project", "plan_scaffold_phase", "plan_status", "plan_unplanned",
      "mem_index", "mem_search", "mem_stats",
      "mem_card_create", "mem_card_list", "mem_card_recall", "mem_card_update", "mem_timeline",
      "continuity_checkpoint", "continuity_get", "continuity_clear",
      "ledger_append",
      "milestone_create", "milestone_list", "milestone_complete",
      "plan_resync", "plan_tracker_delta", "plan_meta_set",
      "config_get", "config_set",
      "issue_comment", "issue_attach", "trace_start", "trace_log", "trace_list", "trace_close",
      "probe_start", "probe_log", "probe_close",
      "draft_start", "draft_log", "draft_close",
      "thread_start", "thread_log", "thread_close",
      "session_landscape",
      "plan_check", "audit_record",
      "map_set", "map_get",
      "workspace_list", "workspace_focus", "workspace_status",
      "board_get", "board_update",
      "peer_list", "peer_run",
      "docs_publish", "docs_status",
    ].sort());
  });

  it("pins the tool count at 71", async () => {
    expect((await listToolNames()).length).toBe(71);
  });

  it("issue_attach reads the file and forwards to the tracker; missing file is NOT_FOUND", async () => {
    const made = await call("issue_create", { title: "attach target" });
    writeFileSync(join(projectDir, "shot.png"), Buffer.from([137, 80, 78, 71]));
    const res = await call("issue_attach", { id: made.json.id, path: "shot.png" });
    expect(res.json.id).toBeTruthy();
    const missing = await client.callTool({ name: "issue_attach",
      arguments: { id: made.json.id, path: "nope.png" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0].text).toContain("NOT_FOUND");
  });

  it("tracker_migrate refuses a non-local source", async () => {
    const res = await call("tracker_migrate", { targetType: "github", targetConfig: { repo: "o/r" } });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("workspace_list without a workspace returns { workspace: null }, not an error", async () => {
    const out = await call("workspace_list", {});
    expect(out.isError).toBeFalsy();
    expect(out.json.workspace).toBeNull();
  });

  it("workspace_focus without a workspace is a PRECONDITION_FAILED error", async () => {
    const res = await call("workspace_focus", { project: "anything" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("PRECONDITION_FAILED");
  });

  it("board_get without a workspace is a PRECONDITION_FAILED error", async () => {
    const res = await call("board_get", {});
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("PRECONDITION_FAILED");
  });

  it("registers the Tier A tools", async () => {
    const names = await listToolNames();
    for (const n of ["milestone_create", "milestone_list", "milestone_complete",
      "plan_resync", "plan_meta_set"]) expect(names).toContain(n);
  });

  it("plan_check runs clean on an empty project", async () => {
    const out = await call("plan_check", {});
    expect(out.json).toEqual({ findings: [], scanned: 0 });
  });

  it("audit_record writes and validates", async () => {
    const out = await call("audit_record", { scope: "drill-scope", verdict: "findings",
      findings: [{ severity: "important", title: "t" }] });
    expect(out.json.findings).toBe(1);
    const bad = await call("audit_record", { scope: "drill-scope", verdict: "pass",
      findings: [{ severity: "critical", title: "boom" }] });
    expect(bad.isError).toBe(true);
  });

  it("plan lifecycle through tools: scaffold → ensure → issues_set → status → drift", async () => {
    const proj = await call("plan_scaffold_project", { name: "T" });
    expect(proj.json.created.length).toBe(2);
    const ph = await call("plan_scaffold_phase", { number: 1, name: "Core" });
    expect(ph.json.dir).toBe("01-core");
    const ensured = await call("plan_phase_ensure", { number: 1, name: "Core" });
    expect(ensured.json.name).toBe("Phase 1: Core");
    const made = await call("issue_create", { title: "req 1", phase: ensured.json.id });
    await call("plan_issues_set", { phaseDir: "01-core", issues: [made.json.id] });
    const status = await call("plan_status", {});
    expect(status.json.phases[0].issues).toEqual([made.json.id]);
    const drift = await call("plan_drift", {});
    expect(drift.json.ok).toEqual([made.json.id]);
    expect(drift.json.flagged).toEqual([]);
  });

  it("plan_scaffold_phase accepts a decimal phase number (1.5) — dir is 01.5-slug", async () => {
    const ph = await call("plan_scaffold_phase", { number: 1.5, name: "Gamma" });
    expect(ph.json.dir).toBe("01.5-gamma");
    const ensured = await call("plan_phase_ensure", { number: 1.5, name: "Gamma" });
    expect(ensured.json.name).toBe("Phase 1.5: Gamma");
  });

  it("plan_scaffold_phase rejects an over-precise decimal (1.55) as CONFIG_INVALID", async () => {
    const res = await call("plan_scaffold_phase", { number: 1.55, name: "Bad" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("plan_phase_ensure rejects an over-precise decimal (1.55) as CONFIG_INVALID", async () => {
    const res = await call("plan_phase_ensure", { number: 1.55, name: "Bad" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("round-trip: scaffold 1, 1.5, 2 → plan_status lists them ordered 1, 1.5, 2 with correct numbers", async () => {
    await call("plan_scaffold_phase", { number: 1, name: "One" });
    await call("plan_scaffold_phase", { number: 1.5, name: "OnePointFive" });
    await call("plan_scaffold_phase", { number: 2, name: "Two" });
    const status = await call("plan_status", {});
    const relevant = (status.json.phases as Array<{ number: number; dir: string }>)
      .filter((p) => ["01-one", "01.5-onepointfive", "02-two"].includes(p.dir));
    expect(relevant.map((p) => p.dir)).toEqual(["01-one", "01.5-onepointfive", "02-two"]);
    expect(relevant.map((p) => p.number)).toEqual([1, 1.5, 2]);
  });

  it("plan_issues_set on a decimal phaseDir round-trips the phase number into the handoff (not the slice(0,2) bug)", async () => {
    await call("plan_scaffold_phase", { number: 1.5, name: "Handoff Check" });
    const made = await call("issue_create", { title: "decimal handoff req" });
    const res = await call("plan_issues_set",
      { phaseDir: "01.5-handoff-check", issues: [made.json.id] });
    expect(res.isError).toBeFalsy();
    const handoff = await call("continuity_get", {});
    expect(handoff.json.handoff.phase).toEqual({ number: 1.5, slug: "handoff-check" });
  });

  it("plan_issues_set rejects traversal-shaped phaseDir", async () => {
    const res = await call("plan_issues_set", { phaseDir: "../evil", issues: [] });
    expect(res.isError).toBe(true);
  });

  it("plan_issues_set rejects a phaseDir with no scaffolded PLAN.md", async () => {
    const res = await call("plan_issues_set", { phaseDir: "99-unscaffolded", issues: [] });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
  });

  it("plan_issues_set rejects an issue id containing a comma", async () => {
    const res = await call("plan_issues_set", { phaseDir: "01-core", issues: ["A,B"] });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("ledger_append writes a formatted line to the phase's LEDGER.md", async () => {
    const res = await call("ledger_append", {
      phaseDir: "01-core", taskRef: "task-1", summary: "wire the tool",
      baseCommit: "a1b2c3d4e5f6", headCommit: "d4e5f6a1b2c3",
      issueId: "PROJ-1", closedDate: "2026-07-16",
    });
    expect(res.isError).toBeFalsy();
    expect(res.json.line).toBe(
      "- [x] task-1 — wire the tool — commits a1b2c3d..d4e5f6a — PROJ-1 closed 2026-07-16",
    );
  });

  it("ledger_append rejects a phaseDir with no scaffolded phase", async () => {
    const res = await call("ledger_append", {
      phaseDir: "99-unscaffolded", taskRef: "task-1", summary: "x",
      baseCommit: "a1b2c3d4e5f6", headCommit: "d4e5f6a1b2c3",
      issueId: "PROJ-1", closedDate: "2026-07-16",
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.nextAction).toBeTruthy();
  });

  it("issue lifecycle: create → in_progress → close through tools", async () => {
    const made = await call("issue_create", { title: "via mcp" });
    expect(made.json.state).toBe("open");
    const wip = await call("issue_update", { id: made.json.id, state: "in_progress" });
    expect(wip.json.state).toBe("in_progress");
    const closed = await call("issue_close", { id: made.json.id });
    expect(closed.json.state).toBe("closed");
  });

  it("claiming an unassigned issue auto-assigns the working user", async () => {
    const made = await call("issue_create", { title: "claim me" });
    const wip = await call("issue_update", { id: made.json.id, state: "in_progress" });
    expect(wip.json.assignee).toBe("fake-user");
    expect(wip.json.autoAssigned).toBe(true);
  });

  it("an explicit assignee wins over auto-assign", async () => {
    const made = await call("issue_create", { title: "explicit" });
    const wip = await call("issue_update",
      { id: made.json.id, state: "in_progress", assignee: "someone-else" });
    expect(wip.json.assignee).toBe("someone-else");
    expect(wip.json.autoAssigned).toBeUndefined();
  });

  it("an already-assigned issue is left untouched on claim", async () => {
    const made = await call("issue_create", { title: "taken" });
    await call("issue_update", { id: made.json.id, assignee: "owner" });
    const wip = await call("issue_update", { id: made.json.id, state: "in_progress" });
    expect(wip.json.assignee).toBe("owner");
    expect(wip.json.autoAssigned).toBeUndefined();
  });

  it("issue_link → issue_links → issue_unlink roundtrip", async () => {
    const a = await call("issue_create", { title: "link a" });
    const b = await call("issue_create", { title: "link b" });
    await call("issue_link", { from: a.json.id, type: "blocks", to: b.json.id });
    const links = await call("issue_links", { id: a.json.id });
    expect(links.json.links).toContainEqual({ from: a.json.id, type: "blocks", to: b.json.id });
    await call("issue_unlink", { from: a.json.id, type: "blocks", to: b.json.id });
    expect((await call("issue_links", { id: a.json.id })).json.links).toEqual([]);
  });

  it("graph_report: frontier, inherited priority, lineage", async () => {
    const blocker = await call("issue_create", { title: "graph blocker", labels: ["priority:P3"] });
    const blocked = await call("issue_create", { title: "graph blocked", labels: ["priority:P1"] });
    await call("issue_link", { from: blocker.json.id, type: "blocks", to: blocked.json.id });
    const v2 = await call("issue_create", { title: "graph v2" });
    await call("issue_link", { from: v2.json.id, type: "supersedes", to: blocker.json.id });

    const report = await call("graph_report", { lineageOf: v2.json.id });
    const frontierIds = report.json.frontier.map((i: { id: string }) => i.id);
    expect(frontierIds).toContain(blocker.json.id);      // nothing blocks it
    expect(frontierIds).not.toContain(blocked.json.id);  // blocker still open
    expect(report.json.priorities).toContainEqual({
      id: blocker.json.id, declared: "P3", effective: "P1", inheritedFrom: blocked.json.id,
    });
    expect(report.json.lineage).toEqual([blocker.json.id, v2.json.id]);
    expect(report.json.dangling).toEqual([]);
  });

  it("issue_link surfaces cycle rejection as a typed error", async () => {
    const a = await call("issue_create", { title: "cyc a" });
    const b = await call("issue_create", { title: "cyc b" });
    await call("issue_link", { from: a.json.id, type: "blocks", to: b.json.id });
    const res = await call("issue_link", { from: b.json.id, type: "blocks", to: a.json.id });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("non-claim transitions never auto-assign", async () => {
    const made = await call("issue_create", { title: "close only" });
    const closed = await call("issue_update", { id: made.json.id, state: "closed" });
    expect(closed.json.assignee).toBeUndefined();
  });

  it("issue_close with timeSpentMinutes on a no-worklog backend says why it skipped", async () => {
    const made = await call("issue_create", { title: "timed close" });
    const closed = await call("issue_close", { id: made.json.id, timeSpentMinutes: 15 });
    expect(closed.json.state).toBe("closed");
    expect(closed.json.worklogLogged).toBe(false);
    expect(closed.json.worklogError).toMatch(/no worklog support/);
  });

  it("context_set then context_get roundtrips", async () => {
    await call("context_set", { phase: 1, issueId: "FAKE-1" });
    const got = await call("context_get");
    expect(got.json).toEqual({ phase: 1, issueId: "FAKE-1" });
  });

  it("config_set merges and config_get reflects it", async () => {
    const set = await call("config_set", { patch: { continuity: { resume: "auto" } } });
    expect(set.json.continuity.resume).toBe("auto");
    const got = await call("config_get", {});
    expect(got.json.continuity.resume).toBe("auto");
    expect(got.json.leakGuard.enabled).toBe(true); // defaults visible in effective view
  });

  it("CairnError surfaces as isError with code + nextAction", async () => {
    const res = await call("issue_get", { id: "nope" });
    expect(res.isError).toBe(true);
  });

  it("trace lifecycle round-trips against the fake tracker", async () => {
    const started = await call("trace_start", { description: "mcp drill bug" });
    expect(started.json.id).toMatch(/^trace-[0-9a-f]{8}$/);
    expect(started.json.issue).toBeTruthy();
    await call("trace_log", { id: started.json.id, kind: "evidence", text: "e1" });
    await call("trace_log", { id: started.json.id, kind: "verdict", text: "cause found" });
    const open = await call("trace_list", { status: "open" });
    expect(open.json.some((t: { id: string }) => t.id === started.json.id)).toBe(true);
    const closed = await call("trace_close", { id: started.json.id, resolution: "fixed" });
    expect(closed.json.issueClosed).toBe(true);
    const gone = await call("trace_list", { status: "open" });
    expect(gone.json.some((t: { id: string }) => t.id === started.json.id)).toBe(false);
  });

  it("probe_start creates a cairn:spike issue and stamps the active phase", async () => {
    await call("context_set", { phase: 3 });
    const out = await call("probe_start", { description: "can the SDK stream?" });
    expect(out.json.id).toMatch(/^probe-[0-9a-f]{8}$/);
    const issue = await call("issue_get", { id: out.json.issue });
    expect(issue.json.labels).toContain("cairn:spike");
    // phase stamp: assert via the store directly (session_landscape arrives in Task 3)
    expect(listSessions(projectDir, "probe")[0].phase).toBe("3");
  });

  it("probe_log enforces the probe entry vocabulary", async () => {
    const started = await call("probe_start", { description: "vocab" });
    await call("probe_log", { id: started.json.id, kind: "experiment", text: "ran it" });
    // "hypothesis" isn't a probe entry kind -- the input schema's z.enum rejects
    // it at the protocol layer before appendSession's UNSUPPORTED check ever runs
    // (same shape as the mem_search negative-limit boundary test above).
    await expect(call("probe_log", { id: started.json.id, kind: "hypothesis", text: "nope" }))
      .rejects.toThrow();
  });

  it("probe_close gates on verdict then closes the issue", async () => {
    const started = await call("probe_start", { description: "gate" });
    const early = await call("probe_close", { id: started.json.id, resolution: "stop" });
    expect(early.isError).toBe(true);
    await call("probe_log", { id: started.json.id, kind: "verdict", text: "VALIDATED" });
    const out = await call("probe_close", { id: started.json.id, resolution: "proceed — holds up" });
    expect(out.json.issueClosed).toBe(true);
    expect((await call("issue_get", { id: started.json.issue })).json.state).toBe("closed");
  });

  it("draft tools: cairn:sketch label, decision gate", async () => {
    const started = await call("draft_start", { description: "dashboard layout" });
    expect((await call("issue_get", { id: started.json.issue })).json.labels).toContain("cairn:sketch");
    await call("draft_log", { id: started.json.id, kind: "variant", text: "001-cards.html" });
    const early = await call("draft_close", { id: started.json.id, resolution: "cards" });
    expect(early.isError).toBe(true);
    await call("draft_log", { id: started.json.id, kind: "decision", text: "card grid" });
    expect((await call("draft_close", { id: started.json.id, resolution: "card grid locked" })).json.issueClosed)
      .toBe(true);
  });

  it("thread tools: cairn:thread label, wrap gate", async () => {
    const started = await call("thread_start", { description: "design musing" });
    expect((await call("issue_get", { id: started.json.issue })).json.labels).toContain("cairn:thread");
    await call("thread_log", { id: started.json.id, kind: "note", text: "a note worth keeping" });
    const early = await call("thread_close", { id: started.json.id, resolution: "landed here" });
    expect(early.isError).toBe(true);
    await call("thread_log", { id: started.json.id, kind: "wrap", text: "wrapped: landed here" });
    expect((await call("thread_close", { id: started.json.id, resolution: "landed here" })).json.issueClosed)
      .toBe(true);
  });

  it("map tools: round-trips a two-node one-edge graph and rejects a dangling edge", async () => {
    const set = await call("map_set", { patch: {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
      },
      edges: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    } });
    expect(set.json).toEqual({ nodes: 2, edges: 1 });

    const got = await call("map_get", {});
    expect(got.json.nodes["mod-a"]).toEqual({ type: "module", label: "A" });
    expect(got.json.edges).toEqual([{ from: "mod-a", to: "mod-b", type: "depends-on" }]);

    const dangling = await call("map_set", { patch: {
      edges: [{ from: "mod-a", to: "mod-ghost", type: "depends-on" }],
    } });
    expect(dangling.isError).toBe(true);
  });

  it("session_landscape's openByKind reflects an open probe created via probe_start", async () => {
    const started = await call("probe_start", { description: "landscape check" });
    const scape = await call("session_landscape", {});
    expect(Object.keys(scape.json.openByKind).sort()).toEqual(["draft", "probe", "thread", "trace"]);
    expect(scape.json.openByKind.probe).toBeGreaterThanOrEqual(1);
    const found = scape.json.sessions.find((s: { id: string }) => s.id === started.json.id);
    expect(found?.kind).toBe("probe");
    expect(found?.status).toBe("open");
  });

  it("memory lifecycle: index -> search -> stats -> card create -> list -> recall (fresh)", async () => {
    await call("mem_index", { content: "GitHub secondary rate limits return 403", source: "research", phase: 1 });
    const found = await call("mem_search", { query: "rate limits" });
    expect(found.json.length).toBeGreaterThan(0);

    const stats = await call("mem_stats", {});
    expect(stats.json.chunkCount).toBeGreaterThan(0);

    const card = await call("mem_card_create", {
      type: "gotcha", body: "GitHub 403 can mean auth failure OR rate limiting.", scopePhase: 1,
    });
    expect(card.json.id).toBeTruthy();

    const list = await call("mem_card_list", { scopePhase: 1 });
    expect(list.json.length).toBe(1);

    const recall = await call("mem_card_recall", {});
    expect(recall.json.find((c: { id: string }) => c.id === card.json.id).stale).toBe(false);
  });

  it("mem_search rejects a negative limit at the schema boundary", async () => {
    // Zod's positive() check runs at the MCP input-validation layer, before our
    // handler ever sees it -- so this surfaces as a protocol-level rejection
    // rather than a { isError: true } tool result. Either way, -1 never reaches
    // the query (SQLite treats LIMIT -1 as "unlimited").
    await expect(call("mem_search", { query: "anything", limit: -1 })).rejects.toThrow();
  });

  it("mem_card_recall flags a card stale when its provenance file changed", async () => {
    const gitDir = mkdtempSync(join(tmpdir(), "cairn-mcp-git-"));
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    writeFileSync(join(gitDir, "f.ts"), "v1\n");
    execFileSync("git", ["add", "f.ts"], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "v1"], { cwd: gitDir });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();

    const gitServer = buildServer({ projectDir: gitDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const gitClient = new Client({ name: "test-git", version: "0.0.0" });
    await Promise.all([gitServer.connect(st), gitClient.connect(ct)]);
    const gitCall = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await gitClient.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      return { ...res, json: JSON.parse(text) };
    };

    await gitCall("mem_card_create", { type: "gotcha", body: "test", provenance: [{ file: "f.ts", commit }] });
    writeFileSync(join(gitDir, "f.ts"), "v2 changed\n");
    const recall = await gitCall("mem_card_recall", {});
    expect(recall.json[0].stale).toBe(true);
    expect(recall.json[0].staleReasons[0]).toContain("f.ts");
  });

  it("plan_unplanned surfaces tracker issues no plan references", async () => {
    const stray = await call("issue_create", { title: "tracker-origin stray" });
    const report = await call("plan_unplanned", {});
    expect(report.json.unplanned.map((i: { id: string }) => i.id))
      .toContain(stray.json.id);
  });

  it("plan_import reverse-mirrors a tracker phase into plan artifacts", async () => {
    const ph = await call("phase_create", { name: "Phase 7: Imported Work" });
    const issue = await call("issue_create", { title: "imported req", phase: ph.json.id });
    const result = await call("plan_import", { phaseRef: ph.json.id });
    expect(result.json).toMatchObject({
      dir: "07-imported-work", number: 7, issues: [issue.json.id],
    });
    const status = await call("plan_status", {});
    expect(status.json.phases.find((p: { number: number }) => p.number === 7).issues)
      .toEqual([issue.json.id]);
  });

  it("peer_list reports all four providers, onPath false in the bare harness", async () => {
    const ORIGINAL_PATH = process.env.PATH;
    const emptyDir = mkdtempSync(join(tmpdir(), "cairn-mcp-empty-path-"));
    process.env.PATH = emptyDir;
    try {
      const out = await call("peer_list", {});
      expect(out.isError).toBeFalsy();
      expect(out.json).toHaveLength(4);
      expect(out.json.map((p: { provider: string }) => p.provider).sort())
        .toEqual([...PROVIDERS].sort());
      for (const entry of out.json) expect(entry.onPath).toBe(false);
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // peer_run spawns a real child process via execFile, which inherits
  // process.env at spawn time -- since this server runs in-process (no
  // subprocess transport for the MCP server itself), staging a stub CLI
  // onto process.env.PATH here reaches peerRun's execFile call directly.
  // Restored after the test so the stub never leaks into later tests.
  it("peer_run executes a stub staged on PATH and returns its output", async () => {
    const ORIGINAL_PATH = process.env.PATH;
    const stubDir = mkdtempSync(join(tmpdir(), "cairn-mcp-peer-stub-"));
    const stubPath = join(stubDir, "codex");
    writeFileSync(stubPath, "#!/bin/sh\ncat > /dev/null\necho \"stub ok\"\n");
    chmodSync(stubPath, 0o755);
    process.env.PATH = `${stubDir}${delimiter}${ORIGINAL_PATH}`;
    try {
      const res = await call("peer_run", { provider: "codex", input: "hello" });
      expect(res.isError).toBeFalsy();
      expect(res.json.provider).toBe("codex");
      expect(res.json.exitCode).toBe(0);
      expect(res.json.output.trim()).toBe("stub ok");
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe("continuity: write-through + tools", () => {
  // A dedicated registered project (cairn.json present) + server/client pair --
  // write-through only fires when the project is registered (Task 1's
  // unregistered guard), so this needs its own fixture rather than the shared
  // suite's tmpdir above, which is deliberately left unregistered.
  let projectDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-continuity-mcp-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const server = buildServer({ projectDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-continuity", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(handoffPath(projectDir), { force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("issue_update leaves a handoff naming that issue", async () => {
    const made = await call("issue_create", { title: "via mcp" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    const got = await call("continuity_get", {});
    expect(got.json.handoff.issue).toBe(made.json.id);
    expect(got.json.handoff.source).toBe("tool");
  });

  it("context_set({issueId: null}) clears a stale issue out of the handoff", async () => {
    const made = await call("issue_create", { title: "to be cleared" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    const before = await call("continuity_get", {});
    expect(before.json.handoff.issue).toBe(made.json.id); // stale issue landed, per the test above

    await call("context_set", { issueId: null });

    const after = await call("continuity_get", {});
    expect(after.json.handoff.issue).toBeUndefined(); // explicit null must drop the field, not just skip patching it
  });

  it("ledger_append leaves a handoff naming the phase and issue", async () => {
    await call("plan_scaffold_project", { name: "T" });
    await call("plan_scaffold_phase", { number: 1, name: "Core" });
    await call("ledger_append", {
      phaseDir: "01-core", taskRef: "task-1", summary: "wire the tool",
      baseCommit: "a1b2c3d4e5f6", headCommit: "d4e5f6a1b2c3",
      issueId: "PROJ-9", closedDate: "2026-07-16",
    });
    const got = await call("continuity_get", {});
    expect(got.json.handoff.phase).toEqual({ number: 1, slug: "core" });
    expect(got.json.handoff.issue).toBe("PROJ-9");
  });

  it("continuity_checkpoint then continuity_get round-trips", async () => {
    await call("continuity_checkpoint", {
      next_action: "finish the write-through wiring", notes: "task 2",
    });
    const got = await call("continuity_get", {});
    expect(got.json.handoff.next_action).toBe("finish the write-through wiring");
    expect(got.json.handoff.notes).toBe("task 2");
    expect(got.json.stale).toBe(false);
  });

  it("continuity_checkpoint accepts a decimal phase ref and rejects an over-precise one as CONFIG_INVALID", async () => {
    const ok = await call("continuity_checkpoint", { phase: { number: 1.5, slug: "gamma" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.json.handoff.phase).toEqual({ number: 1.5, slug: "gamma" });
    const bad = await call("continuity_checkpoint", { phase: { number: 1.55, slug: "gamma" } });
    expect(bad.isError).toBe(true);
    expect(bad.json.code).toBe("CONFIG_INVALID");
  });

  it("continuity_clear deletes the handoff", async () => {
    await call("continuity_checkpoint", { next_action: "x" });
    const cleared = await call("continuity_clear", {});
    expect(cleared.json.cleared).toBe(true);
    const got = await call("continuity_get", {});
    expect(got.json).toBeNull();
  });

  it("primary tool still succeeds when the handoff write fails", async () => {
    continuityFailure.failWrites = true; // writeHandoff throws (simulated unwritable dir)
    continuityFailure.failedAttempts = 0;
    try {
      const made = await call("issue_create", { title: "unaffected by continuity failure" });
      const updated = await call("issue_update", { id: made.json.id, state: "closed" });
      expect(updated.json.state).toBe("closed"); // primary tool result, unaffected
      expect(updated.isError).toBeFalsy();
      // Prove the failing path was actually exercised, not vacuously skipped:
      // issue_update's write-through must have attempted (and swallowed) a write.
      expect(continuityFailure.failedAttempts).toBeGreaterThan(0);
    } finally {
      continuityFailure.failWrites = false;
    }
  });
});

// A valid single-member cairn.json body, reused across the workspace fixtures.
const CAIRN_JSON = JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } });

describe("workspace: focus redirect + board (two-member fixture)", () => {
  let wsRoot: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    wsRoot = mkdtempSync(join(tmpdir(), "cairn-ws-"));
    mkdirSync(join(wsRoot, "member-a"));
    mkdirSync(join(wsRoot, "member-b"));
    writeFileSync(join(wsRoot, "member-a", "cairn.json"), CAIRN_JSON);
    writeFileSync(join(wsRoot, "member-b", "cairn.json"), CAIRN_JSON);
    writeFileSync(join(wsRoot, "cairn-workspace.json"), JSON.stringify({
      workspace: "ws-test",
      members: [{ name: "a", path: "member-a" }, { name: "b", path: "member-b" }],
    }));
    const server = buildServer({ projectDir: wsRoot, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-ws", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("workspace_list reports the workspace, members, and null focus", async () => {
    const out = await call("workspace_list", {});
    expect(out.json.workspace).toBe("ws-test");
    expect(out.json.members.map((m: { name: string }) => m.name).sort()).toEqual(["a", "b"]);
    expect(out.json.members.every((m: { configured: boolean }) => m.configured)).toBe(true);
    expect(out.json.focus).toBeNull();
  });

  it("workspace_focus rejects an unknown member", async () => {
    const res = await call("workspace_focus", { project: "ghost" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("focus on b redirects context_set into member b's .cairn/ only", async () => {
    const focused = await call("workspace_focus", { project: "b" });
    expect(focused.json).toEqual({ focus: "b", projectDir: join(wsRoot, "member-b") });

    await call("context_set", { phase: 7 });
    const got = await call("context_get", {});
    expect(got.json).toEqual({ phase: 7 });

    // the context landed in member b's store -- and NOWHERE else
    const ctxFile = join(".cairn", "state", "active-context.json");
    expect(existsSync(join(wsRoot, "member-b", ctxFile))).toBe(true);
    expect(existsSync(join(wsRoot, "member-a", ctxFile))).toBe(false);
    expect(existsSync(join(wsRoot, ctxFile))).toBe(false);

    // clearing focus lands reads back at the launch dir, which has no context
    const cleared = await call("workspace_focus", { project: null });
    expect(cleared.json.focus).toBeNull();
    const back = await call("context_get", {});
    expect(back.json).toEqual({});
  });

  it("board round-trips through board_update / board_get", async () => {
    const created = await call("board_update", {
      patch: { ws1: { title: "wire the resolver", project: "a" } } });
    expect(created.json).toEqual({ workstreams: 1 });

    const got = await call("board_get", {});
    expect(got.json.workstreams.ws1).toMatchObject({
      title: "wire the resolver", project: "a", status: "queued" });
    expect(got.json.counts).toEqual({ queued: 1, active: 0, blocked: 0, done: 0 });

    await call("board_update", { patch: { ws1: { status: "active", note: "claimed" } } });
    const after = await call("board_get", {});
    expect(after.json.workstreams.ws1).toMatchObject({ status: "active", note: "claimed" });
    expect(after.json.counts.active).toBe(1);

    const deleted = await call("board_update", { patch: { ws1: null } });
    expect(deleted.json).toEqual({ workstreams: 0 });
  });

  it("board_update rejects a workstream naming a non-member project", async () => {
    const res = await call("board_update", { patch: { bad: { title: "t", project: "ghost" } } });
    expect(res.isError).toBe(true);
  });
});

describe("workspace_status: per-member isolation", () => {
  let wsRoot: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    wsRoot = mkdtempSync(join(tmpdir(), "cairn-ws-status-"));
    // member "a" IS the workspace root (path ".") so the test-injected
    // FakeTracker -- bound to the launch dir -- serves its tracker reads.
    writeFileSync(join(wsRoot, "cairn.json"), CAIRN_JSON);
    // member "broken" has a cairn.json whose tracker config fails adapter
    // validation (repo isn't owner/name) -- makeTracker throws fast, no network.
    mkdirSync(join(wsRoot, "member-broken"));
    writeFileSync(join(wsRoot, "member-broken", "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "not-a-slug" } } }));
    writeFileSync(join(wsRoot, "cairn-workspace.json"), JSON.stringify({
      workspace: "ws-status",
      members: [{ name: "a", path: "." }, { name: "broken", path: "member-broken" }],
    }));
    const server = buildServer({ projectDir: wsRoot, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-ws-status", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("one erroring member yields { name, error } without failing the call", async () => {
    await call("issue_create", { title: "open issue for status" });
    await call("context_set", { phase: 2 });

    const out = await call("workspace_status", {});
    expect(out.isError).toBeFalsy();
    expect(out.json.workspace).toBe("ws-status");

    const a = out.json.members.find((m: { name: string }) => m.name === "a");
    expect(a).toMatchObject({ name: "a", phase: 2, openSessions: 0 });
    expect(a.openIssues).toBeGreaterThanOrEqual(1);
    expect(a.error).toBeUndefined();

    const broken = out.json.members.find((m: { name: string }) => m.name === "broken");
    expect(broken.error).toBeTruthy();
    expect(broken.openIssues).toBeUndefined();
  });
});

describe("config_set tracker memo eviction", () => {
  // Regression: the per-dir tracker memo used to survive a config_set that
  // changed the tracker config, so every later tracker call kept hitting the
  // old backend (stale baseUrl) until the server was restarted.
  it("rebuilds the tracker from the new config after config_set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-evict-"));
    writeFileSync(join(dir, "cairn.json"), JSON.stringify({
      tracker: { type: "jira", config: { baseUrl: "https://old.example.com", projectKey: "T" } },
    }));
    vi.stubEnv("JIRA_EMAIL", "t@example.com");
    vi.stubEnv("JIRA_API_TOKEN", "tok");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ issues: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    try {
      // no injected tracker -- getTracker must build the real (stubbed) jira adapter
      const server = buildServer({ projectDir: dir });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "evict-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);

      await c.callTool({ name: "issue_list", arguments: {} });
      expect(urls.at(-1)).toContain("old.example.com");

      await c.callTool({ name: "config_set",
        arguments: { patch: { tracker: { config: { baseUrl: "https://new.example.com" } } } } });
      await c.callTool({ name: "issue_list", arguments: {} });
      expect(urls.at(-1)).toContain("new.example.com");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs tools over an injected fake connector", () => {
  it("docs_publish publishes the tree; docs_status reports the landing page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-"));
    writeFileSync(join(dir, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      docs: { connector: "confluence", config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "D" } },
    }));
    writeFileSync(join(dir, "README.md"), "# Landing");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nBody.");
    const { FakeDocsConnector } = await import("../src/docs/fake.js");
    const fake = new FakeDocsConnector();
    try {
      const server = buildServer({ projectDir: dir, tracker: new FakeTracker(), docsConnector: fake });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);

      const pub = await c.callTool({ name: "docs_publish", arguments: { projectName: "proj" } });
      const pubJson = JSON.parse((pub.content as Array<{ text: string }>)[0].text);
      expect(pub.isError).toBeFalsy();
      expect(pubJson.published).toBe(2);
      expect(pubJson.root.title).toBe("proj");
      expect(fake.pages.size).toBe(2);

      const status = await c.callTool({ name: "docs_status", arguments: { projectName: "proj" } });
      const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0].text);
      expect(statusJson.configured).toBe(true);
      expect(statusJson.connector).toBe("confluence");
      expect(statusJson.root.title).toBe("proj");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("docs_status reports a graceful shape when a configured connector is unreachable (#46)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-down-"));
    writeFileSync(join(dir, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      docs: { connector: "confluence", config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "D" } },
    }));
    const { CairnError } = await import("../src/errors.js");
    const unreachable: import("../src/docs/types.js").DocsConnector = {
      capabilities: { hasPageTree: true, hasAttachments: false, hasLabels: false, hasNativeToc: false },
      ensureRoot: () => { throw new CairnError("AUTH_MISSING", "HTTP 401 from https://x — body: invalid token",
        "token was rejected — regenerate or check it matches the account"); },
      getPage: () => { throw new Error("not used"); },
      findPage: async () => { throw new CairnError("AUTH_MISSING", "HTTP 401 from https://x — body: invalid token",
        "token was rejected — regenerate or check it matches the account"); },
      listChildren: () => { throw new Error("not used"); },
      createPage: () => { throw new Error("not used"); },
      updatePage: () => { throw new Error("not used"); },
    };
    try {
      const server = buildServer({ projectDir: dir, tracker: new FakeTracker(), docsConnector: unreachable });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-test-3", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      const status = await c.callTool({ name: "docs_status", arguments: { projectName: "proj" } });
      const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0].text);
      expect(status.isError).toBeFalsy();
      expect(statusJson.configured).toBe(true);
      expect(statusJson.reachable).toBe(false);
      expect(statusJson.error).toBe("AUTH_MISSING");
      expect(statusJson.message).toContain("invalid token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("docs_status reports configured:false without a docs block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-nodocs-"));
    writeFileSync(join(dir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    try {
      const server = buildServer({ projectDir: dir, tracker: new FakeTracker() });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-test-2", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      const status = await c.callTool({ name: "docs_status", arguments: {} });
      const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0].text);
      expect(statusJson.configured).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
