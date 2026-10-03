#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216, #249, #250, #252, #257) -- refuses the git
 *   commands that rewrite a working tree or its history out from under
 *   whoever is in it. Exit 2 blocks the tool call; ANY internal error exits
 *   0 -- never block work because the guard itself broke.
 *
 *   Always, in every session: `git reset --hard` (any flag order, any -C
 *   target) and force-pushes (--force, -f / -fu, --force-with-lease,
 *   --force-if-includes, a `+refspec`) are refused. They throw away work
 *   with no undo, and no cairn verb ever needs them. The owner's escape is
 *   CAIRN_ALLOW_DESTRUCTIVE_GIT=1 -- set for the session, or as the leading
 *   assignment of the one command it unlocks.
 *
 *   While an unattended batch run is live: `git checkout` and `git switch`
 *   (and the hard reset, even when overridden above) aimed at the owner's
 *   own checkout are refused too. A run works in its own worktree; a
 *   checkout in the directory the human is typing in changes their files
 *   underneath them, silently, mid-edit. CAIRN_RUN_OK=1 as the leading
 *   assignment overrides that once. And `git push`, from any worktree, is
 *   refused unless the run manifest's pushAuth is granted (scope is always
 *   the manifest's own phases -- the manifest records no per-push phase,
 *   so granted + a non-empty phase list is the whole test). No override:
 *   push authority is the owner's staging-gate decision (ADR 0007).
 *
 *   Commands are matched on parsed shell words, not a raw regex over the
 *   line -- quoted text (`git commit -m "explain git reset --hard"`) is a
 *   commit message, never a refusal. Command substitution inside double
 *   quotes (`"$(...)"`, backticks) is not text -- the shell runs it, so its
 *   body is checked as a command of its own (#257).
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
 * Index of the `)` closing a `$(` whose body starts at `i` -- nesting-aware,
 * so parens inside quotes, inner substitutions and backticks don't close it
 * early. Unterminated runs to the end of the line.
 */
function closeParen(line, i) {
  let depth = 1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const j = line.indexOf("'", i + 1); i = j < 0 ? line.length : j; continue; }
    if (c === "`") { i = closeTick(line, i + 1); continue; }
    if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === "$" && line[i + 1] === "(") i = closeParen(line, i + 2);
        else if (line[i] === "`") i = closeTick(line, i + 1);
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return line.length;
}

/** Index of the unescaped backtick closing one whose body starts at `i`. */
function closeTick(line, i) {
  for (; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "`") return i;
  }
  return line.length;
}

/**
 * Splits a shell line into segments (one per simple command) of words,
 * honouring single/double quotes and backslash escapes. Quoted text stays
 * inside its word, so `git commit -m "explain git reset --hard"` is one git
 * commit with a message -- never a reset. Separators: ; & | ( ) ` and
 * newlines; an unquoted # at a word start comments out the rest of its line.
 *
 * Command substitution inside double quotes (`"$(...)"`, `"`...`"`) is NOT
 * plain text -- the shell really runs it (#257). Its body is split as a
 * command line of its own and its segments join the result, so
 * `echo "$(git reset --hard)"` is still seen as a reset.
 * Not a full shell grammar -- just enough to find the command words.
 */
function shellSegments(line) {
  const segs = [];
  const subs = []; // bodies of quoted command substitutions, split at the end
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
        // "$( ... )" and "` ... `" run a command -- keep the text in the
        // word, and queue the body to be checked as a command line itself
        if (line[i] === "$" && line[i + 1] === "(") {
          const end = closeParen(line, i + 2);
          subs.push(line.slice(i + 2, end));
          s += line.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        if (line[i] === "`") {
          const end = closeTick(line, i + 1);
          subs.push(line.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"));
          s += line.slice(i, end + 1);
          i = end + 1;
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
  for (const body of subs) segs.push(...shellSegments(body));
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

/** Every manifest for this project whose status is `running`, as { runId, state }. */
function liveRuns(projectDir, baseDir) {
  const { base, hash } = pathHash(projectDir);
  const prefix = `${base}-${hash}-`;
  let entries;
  try {
    entries = readdirSync(join(baseDir, "runs"));
  } catch {
    return []; // no runs dir -- this machine has never staged a batch run
  }
  const live = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(readFileSync(join(baseDir, "runs", name), "utf8"));
      if (state?.status === "running") {
        live.push({ runId: state.runId ?? name.slice(prefix.length, -5), state });
      }
    } catch {
      continue; // a corrupt manifest is not evidence of a live run
    }
  }
  return live;
}

/**
 * True when a running manifest authorizes pushes. The manifest records
 * push authority as granted + a scope that is always "manifest-phases" --
 * it stores no per-push phase, so "covers the phase being pushed" reduces
 * to: granted, scoped to the manifest, and the manifest has phases at all.
 */
function pushAuthorized(state) {
  const auth = state?.pushAuth;
  return auth?.granted === true && auth.scope === "manifest-phases"
    && Array.isArray(state.phases) && state.phases.length > 0;
}

// git push options that eat the following word as their value.
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * True when `git push <args>` overwrites remote history: --force, -f
 * (alone or clustered, e.g. -fu), --force-with-lease[=...],
 * --force-if-includes, or any refspec with a leading `+`.
 */
function isForcePush(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (PUSH_VALUE_OPTS.has(a)) { k++; continue; }
    if (a === "--force" || a === "--force-if-includes" || /^--force-with-lease(=|$)/.test(a)) {
      return true;
    }
    if (/^-[^-]/.test(a)) {
      // short cluster -- `o` takes the rest of the word as its value
      for (const ch of a.slice(1)) {
        if (ch === "o") break;
        if (ch === "f") return true;
      }
      continue;
    }
    if (a.startsWith("+")) return true; // +refspec forces that ref
  }
  return false;
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
  let runs;
  const currentRuns = () => (runs ??= liveRuns(projectDir, baseDir));

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

    // #250 -- force-push, every session
    if (inv.sub === "push" && isForcePush(inv.args) && !allowDestructive
      && !prefixed(DESTRUCTIVE_ENV)) {
      refuseDestructive("git push --force",
        "it overwrites remote history other people may already have pulled.");
    }

    // #252 -- mid-run, a push needs the authority granted at the staging
    // gate. From ANY worktree -- the run's own is exactly where it pushes.
    if (inv.sub === "push") {
      const unauthorized = currentRuns().find((r) => !pushAuthorized(r.state));
      if (unauthorized) {
        console.error(
          `cairn run guard: a batch run (${unauthorized.runId}) is in flight without push ` +
          "authority for its phases — nothing pushes until the owner grants it at staging.",
        );
        console.error("  the phase ends verified-not-pushed; push it yourself from your own");
        console.error("  terminal once the run is done, or stage a run with push authority.");
        process.exit(2);
      }
      continue;
    }

    // #216 -- tree-rewriting commands aimed at the owner's checkout mid-run
    if (!hardReset && inv.sub !== "checkout" && inv.sub !== "switch") continue;
    if (prefixed("CAIRN_RUN_OK")) continue;
    if (!currentRuns().length) continue; // no unattended run in flight -- ordinary work
    if (!isMainWorktree(targetDir(inv.dirs, cwd))) continue; // the run's own worktree

    const name = hardReset ? "git reset --hard" : `git ${inv.sub}`;
    console.error(
      `cairn run guard: a batch run (${runs[0].runId}) is in flight, and this \`${name}\` targets ` +
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
