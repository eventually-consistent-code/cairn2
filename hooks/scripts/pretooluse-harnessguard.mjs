#!/usr/bin/env node

/**
 * Purpose: PreToolUse harness guard (#208) -- refuses agent writes to the
 *   files that define the agent's own harness: the hook directory, the MCP
 *   server config, the settings cascade, and the plugin manifest. An agent
 *   that can rewrite its own hooks can switch off every other control in a
 *   single edit, so this is the backstop the rule-to-control check points
 *   at. Exit 2 blocks the tool call; ANY internal error exits 0 -- never
 *   block work because the guard itself broke.
 *
 *   Threat model, stated plainly so nobody over-trusts it: the realistic
 *   attack is INDIRECT -- instructions embedded in text the agent reads
 *   (an issue body, a review comment, a fetched page) steering it into a
 *   harness edit it would not otherwise make. This guard turns that from a
 *   silent success into a refusal the human sees. It is NOT a sandbox: the
 *   CAIRN_HARNESS_EDIT=1 escape exists for the human, and text that can
 *   steer the agent can also ask for the prefix. Visibility is the control;
 *   isolation is the operating system's job. The Bash coverage is
 *   best-effort text matching over the command -- it catches the shapes an
 *   agent actually writes (redirect, sed -i, tee, cp, mv) and makes no
 *   claim to be a shell parser.
 * Author(s): John Reed
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Protected shapes, matched against a path relative to the project root
 * (POSIX separators). Kept as one list so the refusal line can name which
 * rule fired and `audit security --surface` has one place to read.
 */
const PROTECTED = [
  { re: /^hooks\//, what: "the hook directory" },
  { re: /^\.mcp\.json$/, what: "the MCP server config" },
  { re: /^(?:.*\/)?\.claude\/settings(?:\.[\w-]+)?\.json$/, what: "a settings file" },
  { re: /^(?:.*\/)?\.claude-plugin\/[^/]+\.json$/, what: "the plugin manifest" },
];

/** The user's machine-wide settings, protected wherever the project sits. */
function isGlobalSettings(abs) {
  const home = resolve(homedir());
  return abs === join(home, ".claude", "settings.json") ||
    abs === join(home, ".claude", "settings.local.json");
}

/** Project-relative POSIX path, or null when the path escapes the project. */
function projectRelative(abs, projectDir) {
  const rel = relative(resolve(projectDir), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** The protected-rule description for this path, or null when it is ordinary. */
function protectedBy(rawPath, projectDir) {
  if (!rawPath) return null;
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectDir, rawPath);
  if (isGlobalSettings(abs)) return "your machine-wide Claude settings";
  const rel = projectRelative(abs, projectDir);
  if (rel === null) return null; // outside the project -- not this guard's business
  for (const p of PROTECTED) if (p.re.test(rel)) return p.what;
  return null;
}

/**
 * Best-effort: the path-ish tokens of a shell command. Quoted strings keep
 * their contents; bare words are taken whole. Redirect targets (`> path`)
 * are split off so `foo>hooks/x` is seen. Deliberately generous -- a false
 * positive costs one override, a false negative costs the control.
 */
function candidatePaths(command) {
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s<>|;&]+/g) ?? [];
  return tokens.map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);
}

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const tool = payload?.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "NotebookEdit" && tool !== "Bash") {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const command = payload?.tool_input?.command ?? "";

  // Two override shapes, both explicit and both the human's to set: the
  // session-wide environment variable, and -- for Bash only -- the same
  // prefix convention the leak guard uses.
  if (process.env.CAIRN_HARNESS_EDIT === "1") process.exit(0);
  if (tool === "Bash" && /^\s*CAIRN_HARNESS_EDIT=1\s/.test(command)) process.exit(0);

  let hitPath = null;
  let hitWhat = null;

  if (tool === "Bash") {
    // Only commands that can WRITE are worth scanning; reading a hook file
    // is ordinary work and must stay frictionless.
    const writes = /(^|[\s;&|])(sed\s+[^|;&]*-i|tee|cp|mv|install|truncate|dd|chmod|chown|rm)\b|>>?/;
    if (!writes.test(command)) process.exit(0);
    for (const t of candidatePaths(command)) {
      const what = protectedBy(t, projectDir);
      if (what) { hitPath = t; hitWhat = what; break; }
    }
  } else {
    const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
    const what = protectedBy(p, projectDir);
    if (what) { hitPath = p; hitWhat = what; }
  }

  if (!hitWhat) process.exit(0);

  console.error(
    `cairn harness guard: this would change ${hitWhat} — the configuration that decides ` +
    "what this agent is allowed to do.",
  );
  console.error(`  file: ${hitPath}`);
  console.error("  if you asked for this, set CAIRN_HARNESS_EDIT=1 for the session (or prefix a");
  console.error("  shell command with it) and run it again. If you did not ask for this, something");
  console.error("  the agent read did — check where the instruction came from before allowing it.");
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
