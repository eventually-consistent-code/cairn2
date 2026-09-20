#!/usr/bin/env node

// Context-footprint pin (issue #211).
//
// Everything cairn puts in front of the model BEFORE it is asked to do
// anything: 39 command descriptions in the slash listing, 3 skill
// descriptions in the skill listing, and the fixed prose the SessionStart
// hook injects. That is rent, paid once per session whether or not a single
// verb runs, and nothing was watching it grow.
//
// This guard sums it, prints the breakdown, and fails above a pinned
// budget. The budget is a decision, not a measurement: it moves when
// someone decides the surface has earned more room, exactly like the tool
// count. Raising it to silence a failure is the failure.
//
// ON THE NUMBER. Tokens are estimated as characters / 4. That is an
// approximation, and the script says so in its own output rather than
// implying a precision it does not have. The estimate is stable and
// monotone -- more text always reads as more tokens -- which is all a
// growth guard needs. An exact tokenizer would make the number prettier
// and the guard no better, at the cost of a dependency in a script whose
// whole point is that it is cheap enough to run on every push.
//
// NOT counted, deliberately: verb subroutine bodies and SKILL.md bodies.
// Those load on demand -- that lazy split is the design this budget exists
// to protect, and counting them here would punish exactly the behaviour we
// want (moving prose OUT of the always-resident surface and INTO files
// that load when needed).
//
// COUNTED as of #TBD-issue: MCP tool schemas. They are neither a slash
// listing entry nor an on-demand body -- they are resident on every turn of
// every session, and they are 83% of what cairn actually costs. The guard
// watching only the descriptions was watching the small half.
//
// Exit 0 clean, exit 1 over budget.

import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The pinned budget, in estimated tokens. Pinned AT today's shape, not at
// an aspiration -- the same posture as the tool-count pin, which fixes the
// count at 85 rather than demanding fewer tools. Its job is to make growth
// deliberate, and a budget the tree already fails would just be noise
// everyone learns to skip.
//
// Headroom is small on purpose. There is a known 438-token saving sitting
// in the command descriptions (see issue #226): all 39 end with the same
// "(cairn — /cairn:help for the verb reference)" suffix, which this guard
// found on its first run. Spending that is a discoverability decision the
// owner makes, not a tidy-up; when it happens, this budget comes down with
// it.
//
// It jumped from 2300 to 13712 when tool schemas came inside the fence
// (#TBD-issue). Nothing got worse that day; the guard simply stopped
// excluding 83% of what it was built to watch. The way this number comes
// down is progressive disclosure for schemas -- deferring rarely-used tools
// so they load on call instead of on every turn, the way skill bodies
// already do -- not by moving the pin.
const BUDGET_TOKENS = 13712;

/** chars / 4 — see the note above on why this approximation is the right one. */
const estimateTokens = (chars) => Math.ceil(chars / 4);

/** The `description:` value from a markdown file's YAML frontmatter. */
function frontmatterField(text, field) {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end === -1) return null;
  const block = text.slice(3, end);
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(block);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const parts = [];

// --- 1. command shims: what the slash listing carries ------------------------
// The name and the description are resident; the body is not.
const commandsDir = join(root, "commands");
let commandChars = 0;
let commandCount = 0;
for (const entry of readdirSync(commandsDir)) {
  if (!entry.endsWith(".md")) continue;
  const text = readFileSync(join(commandsDir, entry), "utf8");
  const description = frontmatterField(text, "description");
  if (description === null) continue;
  const hint = frontmatterField(text, "argument-hint") ?? "";
  commandChars += `/cairn:${entry.slice(0, -3)} ${hint} ${description}`.length;
  commandCount++;
}
parts.push({ what: `${commandCount} command descriptions`, chars: commandChars });

// --- 2. skill listing entries ------------------------------------------------
const skillsDir = join(root, "skills");
let skillChars = 0;
let skillCount = 0;
for (const entry of readdirSync(skillsDir)) {
  const path = join(skillsDir, entry, "SKILL.md");
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  const name = frontmatterField(text, "name") ?? entry;
  const description = frontmatterField(text, "description") ?? "";
  skillChars += `${name} ${description}`.length;
  skillCount++;
}
parts.push({ what: `${skillCount} skill descriptions`, chars: skillChars });

// --- 3. SessionStart injection, fixed prose only -----------------------------
// The hook's variable content (a resume block, a banner) is per-session and
// not cairn's standing rent; its hardcoded advisory strings are.
const hookPath = join(root, "hooks", "scripts", "sessionstart-continuity.mjs");
let injectionChars = 0;
if (existsSync(hookPath)) {
  const src = readFileSync(hookPath, "utf8");
  // String literals long enough to be prose rather than a key or a path.
  for (const m of src.matchAll(/"((?:[^"\\]|\\.){40,})"/g)) injectionChars += m[1].length;
}
parts.push({ what: "SessionStart injected prose", chars: injectionChars });

// --- 4. MCP tool schemas ------------------------------------------------------
// Asked of the real server over stdio rather than estimated from source: the
// client sees zod lowered to JSON Schema, which is not the shape src/index.ts
// spells. Requires a built dist -- check-dist already demands one.
//
// The probe is written out to a scratch file and run as its own node process
// (rather than inlined as a `node -e` string) because a JSON-RPC handshake
// full of escaped newlines inside an already-escaped string is exactly the
// kind of fragile that breaks quietly. The scratch file is a temp copy, not
// a project fixture, and it is removed before this script exits either way.
const distPath = join(root, "server", "dist", "index.js");
const probeSrc = `
import { spawn } from "node:child_process";

const p = spawn(process.argv[2], [process.argv[3]], {
  env: { ...process.env, CLAUDE_PROJECT_DIR: process.argv[4] },
  stdio: ["pipe", "pipe", "ignore"],
});

let buf = "";
p.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 2 && msg.result && msg.result.tools) {
      let chars = 0;
      for (const t of msg.result.tools) chars += JSON.stringify(t).length;
      process.stdout.write("CHARS:" + chars + ":" + msg.result.tools.length + "\\n");
      p.kill();
      process.exit(0);
    }
  }
});

p.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "footprint", version: "1" } },
}) + "\\n");

setTimeout(() => {
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\\n");
}, 400);

setTimeout(() => { p.kill(); process.exit(1); }, 15000);
`;

let toolChars = null;
let toolCount = 0;
const scratchDir = mkdtempSync(join(tmpdir(), "cairn-footprint-"));
try {
  const probePath = join(scratchDir, "probe.mjs");
  writeFileSync(probePath, probeSrc);
  const probe = spawnSync(
    process.execPath,
    [probePath, process.execPath, distPath, root],
    { encoding: "utf8", timeout: 20000 },
  );
  const match = /CHARS:(\d+):(\d+)/.exec(probe.stdout ?? "");
  if (match) {
    toolChars = Number(match[1]);
    toolCount = Number(match[2]);
  }
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

if (toolChars === null) {
  console.error("check-footprint: could not list tools from server/dist/index.js.");
  console.error("  Run `cd server && npm run build` first -- the guard measures the");
  console.error("  schemas the client really sees, not an estimate from source.");
  process.exit(1);
}
parts.push({ what: `${toolCount} MCP tool schemas`, chars: toolChars });

// --- report ------------------------------------------------------------------

const totalTokens = parts.reduce((n, p) => n + estimateTokens(p.chars), 0);

const width = Math.max(...parts.map((p) => p.what.length));
for (const p of parts) {
  console.log(`  ${p.what.padEnd(width)}  ${String(estimateTokens(p.chars)).padStart(5)} tokens (est.)`);
}

if (totalTokens > BUDGET_TOKENS) {
  console.error(
    `check-footprint: ${totalTokens} tokens (est.) resident, over the ${BUDGET_TOKENS} budget ` +
    `by ${totalTokens - BUDGET_TOKENS}`);
  console.error("  This is what cairn costs every session before any verb runs.");
  console.error("  Shorten a description, or move prose into a file that loads on demand.");
  console.error("  Raising BUDGET_TOKENS to make this pass is the failure, not the fix —");
  console.error("  move it only when the surface has genuinely earned the room.");
  process.exit(1);
}

console.log(
  `check-footprint: clean — ${totalTokens} tokens (est.) resident of a ${BUDGET_TOKENS} budget, ` +
  `${BUDGET_TOKENS - totalTokens} to spare`);
