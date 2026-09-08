#!/usr/bin/env node

// Tool-count pin guard (issue #139).
// Exactly two test sites are sanctioned to pin the MCP tool total:
//   server/test/mcp.test.ts and server/test/standalone.test.ts.
// A third copy of that number once hid elsewhere in the test tree and
// survived a merge-resolve pass — so a registry change bumped the two known
// pins and left the stray asserting yesterday's count. This check:
//   (a) computes the live tool count from the server registry (same
//       regex-over-source parse as check-surface.mjs — registerTool()
//       literals plus the registerSessionTools() x3 expansion; no dist
//       import, no server boot)
//   (b) sweeps every .ts file under server/test/ for count-shaped
//       assertions and fails any file outside the two known sites that
//       carries one, and any known site that disagrees with the live count
//   (c) fails if a known site has lost its pin assertion entirely.
//
// "Count-shaped" heuristic (kept deliberately narrow — the test tree holds
// 300+ innocent numeric assertions): a line asserting an integer literal via
// .toBe(N) / .toEqual(N) / .toHaveLength(N), where N >= 10 (the tool total
// has been double digits forever; single-digit numerics near tool context
// are subset assertions), and the line or the 3 lines above it mention
// listTools( / listToolNames / "tool count" / tools.length.
// Exit 0 clean, exit 1 with one file:line per failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// --- inputs ------------------------------------------------------------------

const KNOWN_SITES = [
  "server/test/mcp.test.ts",
  "server/test/standalone.test.ts",
];

const ASSERT_RE = /\.(?:toBe|toEqual|toHaveLength)\(\s*(\d+)\s*\)/;
const CONTEXT_RE = /listTools\s*\(|listToolNames|\btool count\b|\btools\.length\b/i;
const MIN_PIN = 10;
const WINDOW = 3; // lines of context above the assertion

// live registry: registerTool("name", …) plus the templated
// registerSessionTools("kind", …) factory, which expands to
// `${kind}_start` / `${kind}_log` / `${kind}_close` at runtime.
// (Same parse as check-surface.mjs — keep the two in step.)
const serverSrc = readFileSync(join(root, "server/src/index.ts"), "utf8");
const registry = new Set(
  [...serverSrc.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
for (const m of serverSrc.matchAll(/registerSessionTools\("([a-z]+)"/g)) {
  const kind = m[1];
  for (const suffix of ["start", "log", "close"]) registry.add(`${kind}_${suffix}`);
}
const liveCount = registry.size;
if (liveCount === 0) failures.push("no registerTool() names found in server/src/index.ts");

// --- sweep -------------------------------------------------------------------

function tsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const pins = []; // { file (repo-relative), line, n }
for (const abs of tsFilesUnder(join(root, "server/test"))) {
  const file = relative(root, abs);
  const lines = readFileSync(abs, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSERT_RE);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < MIN_PIN) continue;
    const windowText = lines.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
    if (CONTEXT_RE.test(windowText)) pins.push({ file, line: i + 1, n });
  }
}

// --- checks ------------------------------------------------------------------

// stray pins: any count-shaped assertion outside the two sanctioned sites
for (const p of pins) {
  if (!KNOWN_SITES.includes(p.file))
    failures.push(
      `${p.file}:${p.line} stray tool-count assertion (${p.n}) — only ${KNOWN_SITES.join(" and ")} may pin the total`);
}

// known sites must exist, still carry a pin, and agree with the live count
for (const site of KNOWN_SITES) {
  const here = pins.filter((p) => p.file === site);
  if (here.length === 0) {
    failures.push(`${site} has no tool-count pin assertion (expected .toBe(${liveCount}) near listTools)`);
    continue;
  }
  for (const p of here) {
    if (p.n !== liveCount)
      failures.push(`${p.file}:${p.line} pins tool count at ${p.n}, live registry says ${liveCount}`);
  }
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-pins: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-pins: clean — live tool count ${liveCount}, ${KNOWN_SITES.length} pin sites agree, no strays`);
