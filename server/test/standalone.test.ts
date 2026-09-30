// The multi-harness contract (CRN-71): the server must boot and serve all
// tools from a bare `node dist/index.js` over stdio — zero Claude Code
// involvement. This is the launch path Grok Build, Copilot CLI, Codex,
// Gemini, and every other MCP client uses.

import { describe, it, expect } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Same scheme as core/continuity.ts's pathHash / metricsPath: sha256 of the
// resolved (never realpath'd) project dir, first 16 hex chars, keyed off
// basename -- CLAUDE_PROJECT_DIR is an env-var string the OS never chdirs
// into, so plain resolve() is what the server itself computes.
function metricsPathFor(home: string, projectDir: string): string {
  const abs = resolve(projectDir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return join(home, ".cairn", "metrics", `${basename(abs)}-${hash}.jsonl`);
}

describe("standalone stdio boot (no Claude Code)", () => {
  // This pin tracks the COMMITTED dist build, not src -- it lags src's tool
  // count (mcp.test.ts's pin) until the next `npm run build` commit lands.
  it("node dist/index.js serves all 87 tools to a plain MCP client", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-standalone-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "local", config: { prefix: "sa" } } }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(serverDir, "dist", "index.js")],
      // HOME points at the temp dir so the spawned server's ~/.cairn writes
      // (registry auto-register, handoff, outlook mirror) stay hermetic --
      // a test run must never edit the user's real machine registry (#93).
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        HOME: projectDir,
        USERPROFILE: projectDir,
      },
    });
    const client = new Client({ name: "harness-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.length).toBe(87);
      // and one real round trip through the local tracker
      const res = await client.callTool({
        name: "issue_create",
        arguments: { title: "standalone boot" },
      });
      const issue = JSON.parse(
        (res.content as Array<{ text: string }>)[0].text,
      );
      expect(issue.id).toMatch(/^sa-/);
    } finally {
      await client.close().catch(() => {});
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  // Coverage gap closed post-review: summarise/sessionSpans were unit-tested
  // in isolation, but nothing exercised the wiring index.ts adds --
  // dir() -> metricsPath -> metricsSegments -> readFileSync -> the tool
  // response -- over a real spawned server. That whole chain could break and
  // every other test would still pass.
  it("context_meter returns a zeroed rollup when no metrics file exists", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-standalone-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "local", config: { prefix: "sa" } } }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(serverDir, "dist", "index.js")],
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        HOME: projectDir,
        USERPROFILE: projectDir,
      },
    });
    const client = new Client({ name: "harness-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      // No metrics file was ever written under this project's cairn home --
      // an empty meter is a true answer, not an error.
      const res = await client.callTool({ name: "context_meter", arguments: {} });
      const report = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(report).toMatchObject({
        sessions: 0, turns: 0, rent: 0, avgContextPerTurn: 0,
      });
    } finally {
      await client.close().catch(() => {});
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("context_meter rolls up a real metrics row written under the spawned server's HOME", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-standalone-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "local", config: { prefix: "sa" } } }),
    );
    // HOME == projectDir here (as in the other cases), so the metrics fixture
    // and the project dir being hashed are the same path.
    const metrics = metricsPathFor(projectDir, projectDir);
    mkdirSync(dirname(metrics), { recursive: true });
    // One row, chosen so the rollup arithmetic is exact:
    //   turns: 10, ctx_sum: 500_000  -> avgContextPerTurn = 500_000 / 10 = 50_000
    //   turns_sidechain: 2 of 10     -> sidechainTurnShare = 0.2
    //   bands all in under150k       -> bandRentShare.under150k = 1, rest 0
    //   residency tool_result/tool_call -> summed straight through, one session
    //   prefix_tokens: 20_000, only sample -> p50 = max = 20_000
    const row = {
      ts: "2026-09-01T10:00:00Z",
      session_id: "s1",
      cache_read_tokens: 500_000,
      context: {
        turns: 10,
        turns_sidechain: 2,
        ctx_sum: 500_000,
        prefix_tokens: 20_000,
        bands: { under150k: 10, to300k: 0, to500k: 0, over500k: 0 },
        residency: { tool_result: 100, tool_call: 50 },
      },
    };
    writeFileSync(metrics, JSON.stringify(row) + "\n");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(serverDir, "dist", "index.js")],
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        HOME: projectDir,
        USERPROFILE: projectDir,
      },
    });
    const client = new Client({ name: "harness-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const res = await client.callTool({ name: "context_meter", arguments: {} });
      const report = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(report).toMatchObject({
        sessions: 1,
        turns: 10,
        rent: 500_000,
        avgContextPerTurn: 50_000,
        sidechainTurnShare: 0.2,
        bandRentShare: { under150k: 1, to300k: 0, to500k: 0, over500k: 0 },
        residency: { tool_result: 100, tool_call: 50 },
        prefixTokens: { p50: 20_000, max: 20_000 },
        spans: 1,
      });
    } finally {
      await client.close().catch(() => {});
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);
});
