#!/usr/bin/env node

/**
 * Purpose: PreToolUse leak guard (#2221) -- blocks `git commit` tool calls
 *   whose STAGED diff would leak cairn-internal refs (.cairn/ paths, phase
 *   refs, cairn labels, tracker ids) into source files. Exit 2 blocks the
 *   tool call; ANY internal error exits 0 -- never block work by accident.
 * Author(s): John Reed
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildPatterns, scanLines, isAllowedPath } from "./leak-patterns.mjs";

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const command = payload?.tool_input?.command ?? "";
  if (payload?.tool_name !== "Bash") process.exit(0);
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0);
  // spec: the override must PREFIX the command -- a quoted mention elsewhere
  // (e.g. a commit message about the flag) must not bypass the guard.
  if (/^\s*CAIRN_LEAK_OK=1\s/.test(command)) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const cfgPath = join(projectDir, "cairn.json");
  if (!existsSync(cfgPath)) process.exit(0);
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (config?.leakGuard?.enabled === false) process.exit(0);

  const diff = execFileSync("git",
    ["diff", "--cached", "-U0", "--diff-filter=ACM"],
    { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

  const patterns = buildPatterns(config);
  const allow = config?.leakGuard?.allow ?? [];
  const hits = [];
  let file = null;
  let skipped = true;
  let lineNo = 0; // file line number of the NEXT added line (from hunk headers)
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      skipped = isAllowedPath(file, allow);
      continue;
    }
    // hunk header: `@@ -a,b +c,d @@` -- c is the file line of the first
    // added line in the hunk (at -U0 there are no context lines to skip).
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = parseInt(hunk[1], 10);
      continue;
    }
    if (skipped || !line.startsWith("+") || line.startsWith("+++")) continue;
    for (const h of scanLines([line.slice(1)], patterns)) {
      hits.push(`${file}:${lineNo}: [${h.name}] ${h.match}`);
    }
    lineNo++;
  }

  if (hits.length > 0) {
    console.error("cairn leak guard: staged changes leak internal refs —");
    for (const h of hits) console.error(`  ${h}`);
    console.error("fix the lines, allowlist the path via `/cairn tune`, or prefix the command with CAIRN_LEAK_OK=1 to override once.");
    process.exit(2);
  }
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
