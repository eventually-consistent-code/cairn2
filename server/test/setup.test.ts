// cairn-setup installer (CRN-71): additive, idempotent wiring of cairn into
// non-Claude harness configs. Runs the real script against temp project dirs
// with a fake HOME so no real harness config is touched.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "setup", "cairn-setup.mjs");

const dirs: string[] = [];
function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(harness: string, project: string, home: string): string {
  return execFileSync(process.execPath, [SETUP, harness, "--project", project], {
    encoding: "utf8", env: { ...process.env, HOME: home },
  });
}

describe("cairn-setup", () => {
  it("grok: merges .mcp.json, installs AGENTS fragment + verb subroutines", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("grok", proj, home);

    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cairn.command).toBe("node");
    expect(mcp.mcpServers.cairn.args[0]).toContain("dist/index.js");

    const agents = readFileSync(join(proj, "AGENTS.md"), "utf8");
    expect(agents).toContain("cairn:begin");
    expect(agents).toContain("| status | One view");

    expect(existsSync(join(proj, ".cairn", "harness", "verbs", "status.md"))).toBe(true);
    expect(existsSync(join(proj, ".cairn", "harness", "SKILL.md"))).toBe(true);
  });

  it("never clobbers existing config or unrelated AGENTS content; idempotent re-run", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, custom: 1 }));
    writeFileSync(join(proj, "AGENTS.md"), "# My project\n\nHouse rules here.\n");

    run("grok", proj, home);
    const first = {
      mcp: readFileSync(join(proj, ".mcp.json"), "utf8"),
      agents: readFileSync(join(proj, "AGENTS.md"), "utf8"),
    };
    const mcp = JSON.parse(first.mcp);
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.custom).toBe(1);
    expect(mcp.mcpServers.cairn).toBeTruthy();
    expect(first.agents).toContain("House rules here.");
    expect(first.agents).toContain("cairn:begin");

    run("grok", proj, home); // idempotent
    expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(first.mcp);
    expect(readFileSync(join(proj, "AGENTS.md"), "utf8")).toBe(first.agents);
  });

  it("copilot: wires ~/.copilot/mcp-config.json, instructions, and prompt files", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(join(home, ".copilot", "mcp-config.json"),
      JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));

    run("copilot", proj, home);

    const cfg = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"));
    expect(cfg.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(cfg.mcpServers.cairn).toBeTruthy();
    expect(readFileSync(join(proj, ".github", "copilot-instructions.md"), "utf8"))
      .toContain("cairn:begin");
    for (const v of ["plan", "work", "status", "verify", "ship"]) {
      expect(existsSync(join(proj, ".github", "prompts", `cairn-${v}.prompt.md`))).toBe(true);
    }
  });

  it("an existing different cairn MCP entry is left untouched", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, ".mcp.json"),
      JSON.stringify({ mcpServers: { cairn: { command: "custom", args: ["mine.js"] } } }));
    const out = run("grok", proj, home);
    expect(out).toContain("left untouched");
    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cairn.command).toBe("custom");
  });
});
