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
 *   isolation is the operating system's job. The Bash coverage reads the
 *   command the way a shell would, closely enough to find what it WRITES:
 *   redirect targets, and the path operands of commands that change files
 *   (tee, mv, rm, sed -i, the destination of cp, and so on), seen through
 *   wrappers and their flags (sudo -u root, env -i, timeout 5) and through
 *   a shell's -c string (bash -lc counts, #254). Quoted text,
 *   heredoc bodies and here-strings are data. A protected path that is only
 *   READ -- run, grepped, piped to head -- passes (#240). It is still not a
 *   full shell parser: a write hidden inside an interpreter (python -c,
 *   node -e) or a $(...) substitution is not seen.
 *
 * removeWhen: the platform isolates agent config at the OS level, so the
 *   agent process cannot write its own hooks or settings (ADR 0016).
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
 * Splits a shell command into simple-command segments, each with its words
 * and its output-redirect targets. Quotes and backslashes are honoured, so a
 * `>` inside a quoted pattern is text. `N>&M` duplicates a descriptor and has
 * no file target; `<` and `<<<` operands are input; a heredoc body is skipped
 * to its delimiter line. Segments break at `;` `&&` `||` `|` `|&` `&` and
 * newlines. (#240)
 */
function shellSegments(command) {
  const segs = [];
  let words = [];
  let redirects = [];
  let cur = null;
  let next = "word"; // what the next completed word is: word | redirect | skip | heredoc
  let heredocStrip = false;
  const heredocs = [];
  const pushWord = () => {
    if (cur === null) return;
    if (next === "redirect") redirects.push(cur);
    else if (next === "heredoc") heredocs.push({ delim: cur, strip: heredocStrip });
    else if (next === "word") words.push(cur);
    next = "word";
    cur = null;
  };
  const endSeg = () => {
    pushWord();
    if (words.length || redirects.length) segs.push({ words, redirects });
    words = [];
    redirects = [];
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const n = command[i + 1];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const end = j < 0 ? command.length : j;
      cur = (cur ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let str = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) { str += command[j + 1]; j += 2; continue; }
        str += command[j];
        j++;
      }
      cur = (cur ?? "") + str;
      i = j + 1;
      continue;
    }
    if (c === "\\" && n !== undefined && n !== "\n") { cur = (cur ?? "") + n; i += 2; continue; }
    if (c === "\n") {
      endSeg();
      // Heredoc bodies begin on the next line; they are data, so skip each
      // one through its delimiter line.
      while (heredocs.length) {
        const h = heredocs.shift();
        let k = i + 1;
        for (;;) {
          const nl = command.indexOf("\n", k);
          const line = command.slice(k, nl < 0 ? command.length : nl);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim || nl < 0) {
            i = nl < 0 ? command.length : nl;
            break;
          }
          k = nl + 1;
        }
      }
      i++;
      continue;
    }
    if (c === " " || c === "\t") { pushWord(); i++; continue; }
    if (c === ">" || (c === "&" && n === ">")) {
      // a bare number right before `>` is the descriptor, not a word
      if (cur !== null && /^\d+$/.test(cur)) cur = null; else pushWord();
      let j = i + (c === "&" ? 2 : 1);
      if (command[j] === ">" || command[j] === "|") j++;
      if (command[j] === "&") { next = "skip"; i = j + 1; continue; } // >&2: a descriptor
      next = "redirect";
      i = j;
      continue;
    }
    if (c === "<") {
      pushWord();
      if (command.startsWith("<<<", i)) { next = "skip"; i += 3; continue; }
      if (n === "<") {
        heredocStrip = command[i + 2] === "-";
        next = "heredoc";
        i += heredocStrip ? 3 : 2;
        continue;
      }
      next = "skip"; // `< file` is read
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      endSeg();
      i += (n === c || (c === "|" && n === "&")) ? 2 : 1;
      continue;
    }
    cur = (cur ?? "") + c;
    i++;
  }
  endSeg();
  return segs;
}

// Commands that change every path operand they are given.
const WRITES_ALL = new Set([
  "tee", "mv", "rm", "rmdir", "unlink", "truncate", "chmod", "chown", "chgrp",
  "touch", "mkdir", "shred",
]);
// Commands that only READ their sources and write the last operand (or -t).
const WRITES_DEST = new Set(["cp", "install", "ln", "rsync"]);
// Shells whose -c string is a command of its own.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// Shell options that take the next word as their value (-o pipefail).
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/**
 * Prefixes that run a later word as the real command, each with the flags
 * that swallow a value (`sudo -u root`, `env -u NAME`, `nice -n 5`). A
 * wrapper's other flags are skipped as plain switches. `positional` counts
 * the bare words a wrapper takes before the command (timeout's duration).
 * Missing these flags is how `sudo -u root tee hooks/a` slipped past (#254).
 */
const WRAPPERS = new Map([
  ["sudo", { short: "ugpChDRTUrt", long: ["--user", "--group", "--host", "--prompt",
    "--close-from", "--chdir", "--role", "--type", "--other-user", "--command-timeout"] }],
  ["doas", { short: "uC", long: [] }],
  ["env", { short: "uCS", long: ["--unset", "--chdir", "--split-string"] }],
  ["nice", { short: "n", long: ["--adjustment"] }],
  ["timeout", { short: "sk", long: ["--signal", "--kill-after"], positional: 1 }],
  ["xargs", { short: "ILnPsdEa", long: ["--max-args", "--max-procs", "--max-chars",
    "--delimiter", "--arg-file", "--eof", "--replace", "--max-lines"] }],
  ["exec", { short: "a", long: [] }],
  ["time", { short: "fo", long: ["--format", "--output"] }],
  ["command", { short: "", long: [] }],
  ["nohup", { short: "", long: [] }],
  ["builtin", { short: "", long: [] }],
  ["setsid", { short: "", long: [] }],
  ["stdbuf", { short: "ioe", long: ["--input", "--output", "--error"] }],
]);

/**
 * Peels assignments and wrappers (with their flags) off the front of a
 * word list, leaving the real command first. Returns the remaining words
 * plus any file a wrapper itself writes (GNU `time -o FILE`).
 */
function unwrap(words) {
  let w = words.slice();
  const writes = [];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (!w.length) break;
    const name = w[0].split("/").pop();
    const spec = WRAPPERS.get(name);
    if (!spec) break;
    w.shift();
    let positional = spec.positional ?? 0;
    // Read the wrapper's own options, stopping at its first bare word.
    while (w.length) {
      const a = w[0];
      if (a === "--") { w.shift(); break; }
      if (a === "-") { w.shift(); continue; } // `env -` is `env -i`
      if (a.startsWith("--")) {
        w.shift();
        const eq = a.indexOf("=");
        const flag = eq < 0 ? a : a.slice(0, eq);
        let val = eq < 0 ? null : a.slice(eq + 1);
        if (eq < 0 && spec.long.includes(flag) && w.length) val = w.shift();
        if (val !== null && name === "env" && flag === "--split-string") w = splitWords(val).concat(w);
        if (val !== null && name === "time" && flag === "--output") writes.push(val);
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        w.shift();
        // A short cluster: the first value-taking letter eats the rest of
        // the cluster, or the next word when it ends the cluster.
        for (let k = 1; k < a.length; k++) {
          if (!spec.short.includes(a[k])) continue;
          const val = k + 1 < a.length ? a.slice(k + 1) : (w.length ? w.shift() : null);
          if (val !== null && name === "env" && a[k] === "S") w = splitWords(val).concat(w);
          if (val !== null && name === "time" && a[k] === "o") writes.push(val);
          break;
        }
        continue;
      }
      break;
    }
    while (positional-- > 0 && w.length) w.shift();
  }
  return { words: w, writes };
}

/** Words of a string as the shell would split them (env -S). */
function splitWords(str) {
  return shellSegments(str).flatMap((s) => s.words);
}

/**
 * The command string a shell runs with -c, or null when there is none.
 * Any short cluster carrying `c` counts (-c, -lc, -ec); the string is the
 * first bare word after the options, never a guess at an index (#254).
 */
function shellCommandString(args) {
  let sawC = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--" || a === "-") return sawC ? (args[k + 1] ?? null) : null;
    if (SHELL_VALUE_OPTS.has(a)) { k++; continue; }
    if (a.startsWith("--")) continue;
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === "-" && a.includes("c")) sawC = true;
      continue;
    }
    return sawC ? a : null; // first bare word: the -c string, or a script path
  }
  return null;
}

/** The paths one segment would write to. Generous inside a write command;
 *  silent for a command that only reads. */
function writeTargets(seg, depth = 0) {
  const targets = seg.redirects.filter((r) => !/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(r));
  const { words: w, writes } = unwrap(seg.words);
  targets.push(...writes);
  if (!w.length) return targets;
  const cmd = w[0].split("/").pop();
  const args = w.slice(1);
  const operands = args.filter((a) => !a.startsWith("-"));
  // A command handed to another shell as a string is still a command: read
  // it the same way, one level down. (The old text-match missed these too.)
  if (depth < 3 && (SHELLS.has(cmd) || cmd === "eval")) {
    const inner = cmd === "eval" ? args.join(" ") : shellCommandString(args);
    if (inner) {
      for (const s of shellSegments(inner)) targets.push(...writeTargets(s, depth + 1));
    }
    return targets;
  }
  if (WRITES_ALL.has(cmd)) {
    targets.push(...operands);
  } else if (WRITES_DEST.has(cmd)) {
    const t = args.indexOf("-t");
    if (t >= 0 && args[t + 1]) targets.push(args[t + 1]);
    else if (operands.length) targets.push(operands[operands.length - 1]);
  } else if ((cmd === "sed" || cmd === "perl") &&
      args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    targets.push(...operands);
  } else if (cmd === "dd") {
    for (const a of args) if (a.startsWith("of=")) targets.push(a.slice(3));
  } else if (cmd === "git") {
    // skip git's own -C <dir> / -c <k=v> before the subcommand
    const rest = args.slice();
    while (rest.length && (rest[0] === "-C" || rest[0] === "-c")) rest.splice(0, 2);
    const sub = rest[0];
    if (["checkout", "restore", "rm", "mv"].includes(sub)) {
      targets.push(...rest.slice(1).filter((a) => !a.startsWith("-")));
    }
  }
  return targets;
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
    // Only what the command WRITES is checked; reading a hook file is
    // ordinary work and must stay frictionless (#240).
    outer: for (const seg of shellSegments(command)) {
      for (const t of writeTargets(seg)) {
        const what = protectedBy(t, projectDir);
        if (what) { hitPath = t; hitWhat = what; break outer; }
      }
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
