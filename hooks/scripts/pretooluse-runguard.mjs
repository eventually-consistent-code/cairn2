#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216, #249) -- refuses the git commands that
 *   rewrite a working tree or its history out from under whoever is in it.
 *   Exit 2 blocks the tool call; ANY internal error exits 0 -- never block
 *   work because the guard itself broke.
 *
 *   Always, in every session: `git reset --hard` (any flag order, any -C
 *   target) is refused. It throws away uncommitted work with no undo, and
 *   no cairn verb ever needs it. The owner's escape is
 *   CAIRN_ALLOW_DESTRUCTIVE_GIT=1 -- set for the session, or as the leading
 *   assignment of the one command it unlocks.
 *
 *   While an unattended batch run is live: `git checkout` and `git switch`
 *   (and the hard reset, even when overridden above) aimed at the owner's
 *   own checkout are refused too. A run works in its own worktree; a
 *   checkout in the directory the human is typing in changes their files
 *   underneath them, silently, mid-edit. CAIRN_RUN_OK=1 as the leading
 *   assignment overrides that once.
 *
 *   Commands are matched on parsed shell words, not a raw regex over the
 *   line -- quoted text (`git commit -m "explain git reset --hard"`) is a
 *   commit message, never a refusal.
 *
 *   "A run is live" is read from the run manifests in the per-machine cairn
 *   home (the `runs` subdirectory there) -- file state, not an environment
 *   variable, so it survives the agent boundaries an env var would not
 *   cross.
 *
 *   "The owner's checkout" is the main working tree. A worktree's git dir
 *   resolves under <main>/.git/worktrees/<name>, so the run's own worktree
 *   is recognised and left alone.
 *
 * removeWhen: headless runs execute in platform-provided isolated
 *   checkouts that cannot reach the human's working directory.
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

// Constants

// Wrappers that just run the next word as the command -- skipped so
// `sudo git reset --hard` is still seen as git.
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time"]);

// git global options that eat the following word as their value.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

// Shells whose `-c <script>` argument is itself a command line worth parsing.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// The session-wide escape for the always-on destructive refusals. Same shape
// as CAIRN_HARNESS_EDIT: set in the environment, or as the leading
// assignment of the very command it unlocks.
const DESTRUCTIVE_ENV = "CAIRN_ALLOW_DESTRUCTIVE_GIT";

/**
 * Splits a shell line into segments (one per simple command) of words,
 * honouring single/double quotes and backslash escapes. Quoted text stays
 * inside its word, so `git commit -m "explain git reset --hard"` is one git
 * commit with a message -- never a reset. Separators: ; & | ( ) ` and
 * newlines; an unquoted # at a word start comments out the rest of its line.
 * Not a full shell grammar -- just enough to find the command words.
 */
function shellSegments(line) {
  const segs = [];
  let words = [];
  let cur = null;
  const endWord = () => { if (cur !== null) { words.push(cur); cur = null; } };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      const stop = j < 0 ? line.length : j;
      cur = (cur ?? "") + line.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
          s += line[i + 1];
          i += 2;
          continue;
        }
        s += line[i];
        i++;
      }
      cur = (cur ?? "") + s;
    } else if (c === "\\") {
      if (i + 1 < line.length && line[i + 1] !== "\n") cur = (cur ?? "") + line[i + 1];
      i++;
    } else if (c === "\n" || ";&|()`".includes(c)) {
      endSeg();
    } else if (/\s/.test(c)) {
      endWord();
    } else if (c === "#" && cur === null) {
      const j = line.indexOf("\n", i);
      i = j < 0 ? line.length : j - 1;
    } else {
      cur = (cur ?? "") + c;
    }
  }
  endSeg();
  return segs;
}

/**
 * Every git invocation in a command line, parsed: the leading VAR=value
 * assignments, the -C directories in order, the subcommand, and its args
 * (cut at a bare `--`, past which words are paths, not flags). Recurses
 * into `sh -c '<script>'` style wrappers.
 */
function gitInvocations(line, depth = 0) {
  const found = [];
  for (const words of shellSegments(line)) {
    let i = 0;
    const assigns = [];
    while (i < words.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { assigns.push(words[i]); i++; continue; }
      if (WRAPPERS.has(words[i])) {
        i++;
        while (i < words.length && words[i].startsWith("-")) i++;
        continue;
      }
      break;
    }
    const cmd = basename(words[i] ?? "");

    // sh -c / bash -lc: the script is one quoted word -- parse it too
    if (SHELLS.has(cmd) && depth < 2) {
      const flag = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
      if (flag > 0 && words[flag + 1]) found.push(...gitInvocations(words[flag + 1], depth + 1));
      continue;
    }
    if (cmd !== "git") continue;

    i++;
    const dirs = [];
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "-C") dirs.push(words[i + 1] ?? "");
      i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
    }
    const rest = words.slice(i + 1);
    const dashes = rest.indexOf("--");
    found.push({
      assigns,
      dirs,
      sub: words[i] ?? "",
      args: dashes < 0 ? rest : rest.slice(0, dashes),
    });
  }
  return found;
}

/** `git -C <dir>` retargets the command (and stacks); honour it over the tool's cwd. */
function targetDir(dirs, cwd) {
  let dir = cwd;
  for (const d of dirs) dir = isAbsolute(d) ? d : join(dir, d);
  return dir;
}

/**
 * True when `dir` is the repository's MAIN working tree (not a linked
 * worktree). A dir git can't read is not the owner's checkout -- false,
 * so one odd -C target never aborts the checks on the rest of the line.
 */
function isMainWorktree(dir) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return !/[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir);
  } catch {
    return false;
  }
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

/** Prints the refusal for an always-on destructive command and blocks. */
function refuseDestructive(name, why) {
  console.error(`cairn run guard: \`${name}\` is refused in every session — ${why}`);
  console.error(`  if you really mean it, set ${DESTRUCTIVE_ENV}=1 for the session,`);
  console.error(`  or prefix this one command with ${DESTRUCTIVE_ENV}=1.`);
  process.exit(2);
}

// Main

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload?.tool_name !== "Bash") process.exit(0);
  const command = payload?.tool_input?.command ?? "";

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const baseDir = process.env.CAIRN_HOME || join(homedir(), ".cairn");
  const cwd = payload?.cwd || projectDir;
  const allowDestructive = process.env[DESTRUCTIVE_ENV] === "1";

  // Read the run manifests at most once, and only if a command needs them
  let runId;
  const currentRun = () => (runId === undefined ? (runId = liveRun(projectDir, baseDir)) : runId);

  for (const inv of gitInvocations(command)) {
    // Overrides only count as the leading assignment of THIS command, so a
    // quoted mention elsewhere can't bypass the guard
    const prefixed = (name) => inv.assigns.includes(`${name}=1`);
    const hardReset = inv.sub === "reset" && inv.args.includes("--hard");

    // #249 -- hard reset, every session
    if (hardReset && !allowDestructive && !prefixed(DESTRUCTIVE_ENV)) {
      refuseDestructive("git reset --hard",
        "it discards uncommitted work with no undo.");
    }

    // #216 -- tree-rewriting commands aimed at the owner's checkout mid-run
    if (!hardReset && inv.sub !== "checkout" && inv.sub !== "switch") continue;
    if (prefixed("CAIRN_RUN_OK")) continue;
    if (!currentRun()) continue; // no unattended run in flight -- ordinary work
    if (!isMainWorktree(targetDir(inv.dirs, cwd))) continue; // the run's own worktree

    const name = hardReset ? "git reset --hard" : `git ${inv.sub}`;
    console.error(
      `cairn run guard: a batch run (${runId}) is in flight, and this \`${name}\` targets ` +
      "the checkout you work in — it would change your files underneath you.",
    );
    console.error("  run the command inside the run's own worktree, wait for the run to finish,");
    console.error("  or prefix it with CAIRN_RUN_OK=1 to override once.");
    process.exit(2);
  }
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
