// The multi-harness contract (CRN-71): the server must boot and serve all
// tools from a bare `node dist/index.js` over stdio — zero Claude Code
// involvement. This is the launch path Grok Build, Copilot CLI, Codex,
// Gemini, and every other MCP client uses.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("standalone stdio boot (no Claude Code)", () => {
  // This pin tracks the COMMITTED dist build, not src -- it lags src's tool
  // count (mcp.test.ts's pin) until the next `npm run build` commit lands.
  it("node dist/index.js serves all 79 tools to a plain MCP client", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-standalone-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "local", config: { prefix: "sa" } } }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(serverDir, "dist", "index.js")],
      // HOME points at the temp dir so the spawned server's ~/.cairn writes
      // (registry auto-register, handoff, outlook mirror) stay hermetic --
      // a test run must never edit the user's real machine registry (#93).
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir,
        HOME: projectDir, USERPROFILE: projectDir },
    });
    const client = new Client({ name: "harness-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.length).toBe(79);
      // and one real round trip through the local tracker
      const res = await client.callTool({ name: "issue_create",
        arguments: { title: "standalone boot" } });
      const issue = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(issue.id).toMatch(/^sa-/);
    } finally {
      await client.close().catch(() => {});
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);
});
