import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { handoffPath } from "../src/core/continuity.js";

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

  beforeAll(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-"));
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
      "issue_list", "issue_update", "phase_create", "phase_list",
      "plan_drift", "plan_import", "plan_issues_set", "plan_phase_ensure",
      "plan_scaffold_project", "plan_scaffold_phase", "plan_status", "plan_unplanned",
      "mem_index", "mem_search", "mem_stats",
      "mem_card_create", "mem_card_list", "mem_card_recall", "mem_card_update", "mem_timeline",
      "continuity_checkpoint", "continuity_get", "continuity_clear",
      "ledger_append",
      "milestone_create", "milestone_list", "milestone_complete",
      "plan_resync", "plan_meta_set",
    ].sort());
  });

  it("registers the Tier A tools", async () => {
    const names = await listToolNames();
    for (const n of ["milestone_create", "milestone_list", "milestone_complete",
      "plan_resync", "plan_meta_set"]) expect(names).toContain(n);
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

  it("context_set then context_get roundtrips", async () => {
    await call("context_set", { phase: 1, issueId: "FAKE-1" });
    const got = await call("context_get");
    expect(got.json).toEqual({ phase: 1, issueId: "FAKE-1" });
  });

  it("CairnError surfaces as isError with code + nextAction", async () => {
    const res = await call("issue_get", { id: "nope" });
    expect(res.isError).toBe(true);
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
