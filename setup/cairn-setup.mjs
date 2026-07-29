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
const HARNESSES = ["grok", "copilot", "codex", "gemini", "cursor", "opencode", "zed", "claude"];
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

/** Merge the [mcp_servers.cairn] block into ~/.codex/config.toml between
 *  marker comments — no TOML parser needed, and re-runs stay byte-identical.
 *  A hand-written cairn block outside the markers is left alone. */
function mergeCodexToml(path) {
  const TOML_BEGIN = "# cairn:begin — managed by cairn-setup; do not edit inside markers";
  const TOML_END = "# cairn:end";
  const { command, args: cmdArgs } = serverCommand();
  const block = `${TOML_BEGIN}\n[mcp_servers.cairn]\ncommand = "${command}"\nargs = [${cmdArgs.map((a) => `"${a}"`).join(", ")}]\n${TOML_END}\n`;
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch { /* new file */ }
  const start = body.indexOf(TOML_BEGIN);
  const end = body.indexOf(TOML_END);
  let next;
  if (start >= 0 && end > start) {
    next = body.slice(0, start) + block + body.slice(end + TOML_END.length + 1);
  } else if (body.includes("[mcp_servers.cairn]")) {
    console.log(`  ${path}: existing 'cairn' entry left untouched (outside cairn-setup markers)`);
    return;
  } else {
    next = body.length ? `${body.trimEnd()}\n\n${block}` : block;
  }
  if (next === body) {
    console.log(`  ${path}: cairn entry already current...`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  console.log(`  ${path}: [mcp_servers.cairn] block written.`);
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
  const cmdSrc = join(repoRoot, "harness", "gemini", "commands", "cairn");
  const cmdOut = join(projectDir, ".gemini", "commands", "cairn");
  mkdirSync(cmdOut, { recursive: true });
  for (const f of readdirSync(cmdSrc)) {
    copyFileSync(join(cmdSrc, f), join(cmdOut, f));
  }
  console.log(`  .gemini/commands/cairn/: TOML commands installed (/cairn:plan, /cairn:work, ...).`);
}

if (harness === "codex") {
  mergeCodexToml(join(homedir(), ".codex", "config.toml"));
  const promptsSrc = join(repoRoot, "harness", "codex", "prompts");
  const promptsOut = join(homedir(), ".codex", "prompts");
  mkdirSync(promptsOut, { recursive: true });
  for (const f of readdirSync(promptsSrc)) {
    copyFileSync(join(promptsSrc, f), join(promptsOut, f));
  }
  console.log(`  ~/.codex/prompts/: cairn prompt files installed (Codex reads AGENTS.md from the project).`);
}

if (harness === "cursor") {
  mergeMcpJson(join(projectDir, ".cursor", "mcp.json"));

  // Hooks port: adapter + the cairn hook scripts, then hooks.json entries.
  const hooksOut = join(projectDir, ".cursor", "hooks", "cairn");
  mkdirSync(hooksOut, { recursive: true });
  copyFileSync(join(repoRoot, "harness", "cursor", "cursor-adapter.mjs"),
    join(hooksOut, "cursor-adapter.mjs"));
  for (const f of readdirSync(join(repoRoot, "hooks", "scripts"))) {
    if (f.endsWith(".mjs")) copyFileSync(join(repoRoot, "hooks", "scripts", f), join(hooksOut, f));
  }
  console.log(`  .cursor/hooks/cairn/: adapter + hook scripts installed.`);

  // Merge our adapter into .cursor/hooks.json, keeping any foreign entries.
  const hooksJsonPath = join(projectDir, ".cursor", "hooks.json");
  const template = JSON.parse(readFileSync(join(repoRoot, "harness", "cursor", "hooks.json"), "utf8"));
  const existing = readJson(hooksJsonPath);
  let next;
  if (!existing) {
    next = template;
  } else {
    next = { ...existing, version: existing.version ?? 1, hooks: { ...(existing.hooks ?? {}) } };
    for (const [event, entries] of Object.entries(template.hooks)) {
      const current = next.hooks[event] ?? [];
      const present = current.some((e) => (e.command ?? "").includes("cursor-adapter.mjs"));
      next.hooks[event] = present ? current : [...current, ...entries];
    }
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  let prior = "";
  try {
    prior = readFileSync(hooksJsonPath, "utf8");
  } catch { /* new file */ }
  if (serialized === prior) {
    console.log(`  ${hooksJsonPath}: cairn hooks already current...`);
  } else {
    writeFileSync(hooksJsonPath, serialized);
    console.log(`  ${hooksJsonPath}: cairn hook entries merged (cost tracker stays Claude-only).`);
  }
}

if (harness === "opencode") {
  // opencode.json uses its own mcp shape: {mcp: {cairn: {type: "local", command: [...]}}}.
  const cfgPath = join(projectDir, "opencode.json");
  const existing = readJson(cfgPath) ?? {};
  const { command, args: cmdArgs } = serverCommand();
  const entry = { type: "local", command: [command, ...cmdArgs], enabled: true };
  const mcp = existing.mcp ?? {};
  if (mcp.cairn) {
    if (JSON.stringify(mcp.cairn) !== JSON.stringify(entry)) {
      console.log(`  ${cfgPath}: existing 'cairn' entry left untouched (differs from this install)`);
    } else {
      console.log(`  ${cfgPath}: cairn entry already present...`);
    }
  } else {
    writeFileSync(cfgPath, JSON.stringify({ ...existing, mcp: { ...mcp, cairn: entry } }, null, 2) + "\n");
    console.log(`  ${cfgPath}: cairn MCP entry added.`);
  }
  const cmdSrc = join(repoRoot, "harness", "opencode", "commands");
  const cmdOut = join(projectDir, ".opencode", "commands");
  mkdirSync(cmdOut, { recursive: true });
  for (const f of readdirSync(cmdSrc)) {
    copyFileSync(join(cmdSrc, f), join(cmdOut, f));
  }
  console.log(`  .opencode/commands/: cairn command files installed (/cairn-plan, /cairn-work, ...).`);
}

if (harness === "zed") {
  // Zed's MCP config lives under context_servers in (project) settings.json.
  const cfgPath = join(projectDir, ".zed", "settings.json");
  const existing = readJson(cfgPath) ?? {};
  const { command, args: cmdArgs } = serverCommand();
  const entry = { command, args: cmdArgs, env: {} };
  const servers = existing.context_servers ?? {};
  if (servers.cairn) {
    if (JSON.stringify(servers.cairn) !== JSON.stringify(entry)) {
      console.log(`  ${cfgPath}: existing 'cairn' entry left untouched (differs from this install)`);
    } else {
      console.log(`  ${cfgPath}: cairn entry already present...`);
    }
  } else {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ ...existing, context_servers: { ...servers, cairn: entry } }, null, 2) + "\n");
    console.log(`  ${cfgPath}: cairn context server added (Zed reads AGENTS.md natively).`);
  }
}

if (harness === "grok") {
  console.log("  grok build reads .mcp.json and AGENTS.md directly — you're done.");
}

if (harness === "claude") {
  console.log("  claude code users should install the plugin instead — the .mcp.json entry works, but the plugin adds hooks, commands, and skills.");
}

console.log("cairn-setup complete.");
