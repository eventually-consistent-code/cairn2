import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";

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

  it("lists the expected tools", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "context_get", "context_set", "issue_close", "issue_create", "issue_get",
      "issue_list", "issue_update", "phase_create", "phase_list",
      "plan_drift", "plan_issues_set", "plan_phase_ensure",
      "plan_scaffold_project", "plan_scaffold_phase", "plan_status",
      "mem_index", "mem_search", "mem_stats",
      "mem_card_create", "mem_card_list", "mem_card_recall",
    ].sort());
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
});
