#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216) -- while an unattended batch run is
 *   live, refuses branch-switching and hard-reset commands issued against
 *   the owner's own checkout. An unattended run works in its own worktree;
 *   a checkout or reset in the directory the human is typing in changes
 *   their files underneath them, silently, mid-edit. Exit 2 blocks the tool
 *   call; ANY internal error exits 0 -- never block work because the guard
 *   itself broke.
 *
 *   "A run is live" is read from the run manifests in the per-machine cairn
 *   home (the `runs` subdirectory there) -- file state, not an environment
 *   variable, so it survives the agent boundaries an env var would not
 *   cross.
 *
 *   "The owner's checkout" is the main working tree. A worktree's git dir
 *   resolves under <main>/.git/worktrees/<name>, so the run's own worktree
 *   is recognised and left alone.
 * Author(s): John Reed
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

// Same per-machine hashing scheme as lib.mjs / server continuity -- inlined
// so this guard stays importable from a bare node with no sibling loads.
function pathHash(projectDir) {
  const abs = resolve(projectDir);
  return { base: basename(abs), hash: createHash("sha256").update(abs).digest("hex").slice(0, 16) };
}

// The three shapes that rewrite a working tree out from under whoever is in
// it. Matched on the git subcommand, not anywhere in the line, so a commit
// message mentioning "checkout" is not a refusal.
const DANGEROUS = [
  { re: /\bgit\b(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+checkout\b/, name: "git checkout" },
  { re: /\bgit\b(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+switch\b/, name: "git switch" },
  { re: /\bgit\b(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+reset\b[^|;&]*--hard\b/, name: "git reset --hard" },
];

/** `git -C <dir>` retargets the command; honour it over the tool's cwd. */
function explicitTarget(command, cwd) {
  const m = /\bgit\s+(?:-[^\s]+\s+)*-C\s+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/.exec(command);
  if (!m) return null;
  const raw = m[1].replace(/^["']|["']$/g, "");
  return isAbsolute(raw) ? raw : join(cwd, raw);
}

/** True when `dir` is the repository's MAIN working tree (not a linked worktree). */
function isMainWorktree(dir) {
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"],
    { cwd: dir, encoding: "utf8" }).trim();
  return !/[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir);
}

/** The runId of a manifest for this project whose status is `running`, else null. */
function liveRun(projectDir, baseDir) {
  const { base, hash } = pathHash(projectDir);
  const prefix = `${base}-${hash}-`;
  let entries;
  try {
    entries = readdirSync(join(baseDir, "runs"));
  } catch {
    return null; // no runs dir -- this machine has never staged a batch run
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(readFileSync(join(baseDir, "runs", name), "utf8"));
      if (state?.status === "running") return state.runId ?? name.slice(prefix.length, -5);
    } catch {
      continue; // a corrupt manifest is not evidence of a live run
    }
  }
  return null;
}

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload?.tool_name !== "Bash") process.exit(0);
  const command = payload?.tool_input?.command ?? "";

  // Same override convention as the leak guard: it must PREFIX the command,
  // so a quoted mention elsewhere cannot bypass the guard.
  if (/^\s*CAIRN_RUN_OK=1\s/.test(command)) process.exit(0);

  const hit = DANGEROUS.find((d) => d.re.test(command));
  if (!hit) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const baseDir = process.env.CAIRN_HOME || join(homedir(), ".cairn");

  const runId = liveRun(projectDir, baseDir);
  if (!runId) process.exit(0); // no unattended run in flight -- ordinary work

  const target = explicitTarget(command, payload?.cwd || projectDir) || payload?.cwd || projectDir;
  if (!isMainWorktree(target)) process.exit(0); // the run's own worktree -- allowed

  console.error(
    `cairn run guard: a batch run (${runId}) is in flight, and this \`${hit.name}\` targets ` +
    "the checkout you work in — it would change your files underneath you.",
  );
  console.error("  run the command inside the run's own worktree, wait for the run to finish,");
  console.error("  or prefix it with CAIRN_RUN_OK=1 to override once.");
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
