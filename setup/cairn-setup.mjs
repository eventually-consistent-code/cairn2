#!/usr/bin/env node

// cairn-setup — wire cairn into a non-Claude harness (CRN-71).
//
//   node setup/cairn-setup.mjs <harness> [--project <dir>]
//   harness: grok | copilot | codex | gemini | cursor | claude
//
// What it does, per project:
//   1. merges a `cairn` entry into the project's .mcp.json (read directly by
//      Claude Code, Grok Build, and Cursor)
//   2. installs the AGENTS.md cairn fragment (marker-delimited, idempotent)
//   3. copies the verb subroutines to .cairn/harness/ so harnesses without
//      the plugin can read them
//   4. harness-specific wiring (Copilot mcp-config + instructions + prompts;
//      Codex prints its config.toml block; Gemini merges settings + GEMINI.md)
//
// Additive and idempotent: existing config entries are merged, never
// clobbered; re-running produces byte-identical results.
// Dependency-free node — builtins only.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESSES = ["grok", "copilot", "codex", "gemini", "cursor", "claude"];
const BEGIN = "<!-- cairn:begin";
const END = "<!-- cairn:end -->";

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage: node setup/cairn-setup.mjs <${HARNESSES.join("|")}> [--project <dir>]`);
  process.exit(msg ? 1 : 0);
}

// --- args --------------------------------------------------------------------

const args = process.argv.slice(2);
const harness = args[0];
if (!harness || harness.startsWith("--")) usage("missing harness");
if (!HARNESSES.includes(harness)) usage(`unknown harness: ${harness}`);
const projIdx = args.indexOf("--project");
const projectDir = resolve(projIdx >= 0 ? args[projIdx + 1] : process.cwd());

// --- helpers -----------------------------------------------------------------

/** The command that launches the server: the npm bin when this script runs
 *  from the published package, else this clone's built server. */
function serverCommand() {
  const dist = join(repoRoot, "server", "dist", "index.js");
  if (existsSync(dist)) return { command: "node", args: [dist] };
  return { command: "npx", args: ["-y", "@eventually-consistent/cairn-server"] };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Merge the cairn server entry into an mcpServers-shaped JSON config.
 *  An existing, different `cairn` entry is left alone (reported, not clobbered). */
function mergeMcpJson(path) {
  const existing = readJson(path) ?? {};
  const servers = existing.mcpServers ?? {};
  const entry = serverCommand();
  if (servers.cairn) {
    if (JSON.stringify(servers.cairn) !== JSON.stringify(entry)) {
      console.log(`  ${path}: existing 'cairn' entry left untouched (differs from this install)`);
    } else {
      console.log(`  ${path}: cairn entry already present...`);
    }
    return;
  }
  const next = { ...existing, mcpServers: { ...servers, cairn: entry } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  console.log(`  ${path}: cairn MCP entry added.`);
}

/** Install/replace the marker-delimited cairn fragment inside a markdown file. */
function installFragment(path, fragment) {
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch { /* new file */ }
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  let next;
  if (start >= 0 && end > start) {
    next = body.slice(0, start) + fragment.trimEnd() + body.slice(end + END.length);
  } else {
    next = body.length ? `${body.trimEnd()}\n\n${fragment}` : fragment;
  }
  if (next === body) {
    console.log(`  ${path}: cairn section already current...`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  console.log(`  ${path}: cairn section installed.`);
}

/** Copy the verb subroutines + registry into the project for pluginless harnesses. */
function installVerbs() {
  const srcDir = join(repoRoot, "skills", "cairn-trailhead");
  const outDir = join(projectDir, ".cairn", "harness");
  mkdirSync(join(outDir, "verbs"), { recursive: true });
  copyFileSync(join(srcDir, "SKILL.md"), join(outDir, "SKILL.md"));
  let n = 0;
  for (const f of readdirSync(join(srcDir, "verbs"))) {
    if (!f.endsWith(".md")) continue;
    copyFileSync(join(srcDir, "verbs", f), join(outDir, "verbs", f));
    n++;
  }
  console.log(`  .cairn/harness/: registry + ${n} verb subroutines installed.`);
}

// --- main --------------------------------------------------------------------

const fragment = readFileSync(join(repoRoot, "harness", "AGENTS-cairn.md"), "utf8");
console.log(`wiring cairn into ${harness} for ${projectDir}...`);

// Universal layer — every harness benefits from these three.
mergeMcpJson(join(projectDir, ".mcp.json"));
installFragment(join(projectDir, "AGENTS.md"), fragment);
installVerbs();

if (harness === "copilot") {
  mergeMcpJson(join(homedir(), ".copilot", "mcp-config.json"));
  installFragment(join(projectDir, ".github", "copilot-instructions.md"), fragment);
  const promptsSrc = join(repoRoot, "harness", "copilot", "prompts");
  const promptsOut = join(projectDir, ".github", "prompts");
  mkdirSync(promptsOut, { recursive: true });
  for (const f of readdirSync(promptsSrc)) {
    copyFileSync(join(promptsSrc, f), join(promptsOut, f));
  }
  console.log(`  .github/prompts/: cairn prompt files installed.`);
}

if (harness === "gemini") {
  const settingsPath = join(homedir(), ".gemini", "settings.json");
  mergeMcpJson(settingsPath);
  installFragment(join(projectDir, "GEMINI.md"), fragment);
}

if (harness === "codex") {
  const { command, args: cmdArgs } = serverCommand();
  console.log(`  add to ~/.codex/config.toml (Codex reads AGENTS.md from the project):\n`);
  console.log(`  [mcp_servers.cairn]`);
  console.log(`  command = "${command}"`);
  console.log(`  args = [${cmdArgs.map((a) => `"${a}"`).join(", ")}]\n`);
}

if (harness === "cursor") {
  mergeMcpJson(join(projectDir, ".cursor", "mcp.json"));
}

if (harness === "grok") {
  console.log("  grok build reads .mcp.json and AGENTS.md directly — you're done.");
}

if (harness === "claude") {
  console.log("  claude code users should install the plugin instead — the .mcp.json entry works, but the plugin adds hooks, commands, and skills.");
}

console.log("cairn-setup complete.");
