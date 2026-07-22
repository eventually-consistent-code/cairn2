#!/usr/bin/env node

// Surface-conformance check (Tier 0, G9 ratchet).
// Verifies the /cairn command surface can't drift:
//   (a) every `live` routing-table row has its verbs/<verb>.md file
//   (b) every verbs/*.md file has a `live` table row (reserved-with-file fails)
//   (c) subroutine frontmatter is exactly verb/args/status and verb matches filename
//   (d) every prefixed tool reference in verb docs exists in the server registry
//   (e) the reserved verb set matches the Tier 0 spec exactly
// Exit 0 clean, exit 1 with one line per failure.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// --- inputs -----------------------------------------------------------------

const SPEC_RESERVED = {
  basecamp: "F",
};
const TOOL_PREFIXES = /^(context|issue|plan|mem|continuity|ledger|milestone|config|trace|probe|draft|session|audit)_/;

const skillMd = readFileSync(
  join(root, "skills/cairn-trailhead/SKILL.md"), "utf8");

// routing table rows: | `verb` | purpose | args | verbs/<verb>.md | status |
const rows = [];
for (const line of skillMd.split("\n")) {
  const m = line.match(
    /^\|\s*`([a-z]+)`\s*\|.*\|\s*(verbs\/[a-z]+\.md)\s*\|\s*(live|reserved-[A-F0-9]+)\s*\|\s*$/);
  if (m) rows.push({ verb: m[1], path: m[2], status: m[3] });
}
if (rows.length === 0) failures.push("no routing-table rows parsed from SKILL.md");

const verbFiles = readdirSync(join(root, "skills/cairn-trailhead/verbs"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));

// server registry: registerTool("name", …) plus the templated
// registerSessionTools("kind", …) factory, which expands to
// `${kind}_start` / `${kind}_log` / `${kind}_close` at runtime.
const serverSrc = readFileSync(join(root, "server/src/index.ts"), "utf8");
const registry = new Set(
  [...serverSrc.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]));
for (const m of serverSrc.matchAll(/registerSessionTools\("([a-z]+)"/g)) {
  const kind = m[1];
  for (const suffix of ["start", "log", "close"]) registry.add(`${kind}_${suffix}`);
}
if (registry.size === 0) failures.push("no registerTool() names found in server/src/index.ts");

// --- checks ------------------------------------------------------------------

const liveRows = rows.filter((r) => r.status === "live");
const reservedRows = rows.filter((r) => r.status !== "live");

// (a) live row -> file
for (const r of liveRows) {
  if (!verbFiles.includes(r.verb))
    failures.push(`(a) live verb '${r.verb}' has no verbs/${r.verb}.md`);
  if (r.path !== `verbs/${r.verb}.md`)
    failures.push(`(a) row '${r.verb}' names ${r.path}, expected verbs/${r.verb}.md`);
}

// (b) file -> live row
for (const v of verbFiles) {
  const row = rows.find((r) => r.verb === v);
  if (!row) failures.push(`(b) verbs/${v}.md has no routing-table row`);
  else if (row.status !== "live")
    failures.push(`(b) verbs/${v}.md exists but row status is '${row.status}' (reserved verbs must not have files)`);
}

// (c) frontmatter shape + (d) tool references
for (const v of verbFiles) {
  const doc = readFileSync(join(root, `skills/cairn-trailhead/verbs/${v}.md`), "utf8");
  const fm = doc.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { failures.push(`(c) verbs/${v}.md missing frontmatter`); continue; }
  const keys = fm[1].split("\n")
    .map((l) => l.match(/^([a-z]+):/)).filter(Boolean).map((m) => m[1]);
  if (keys.join(",") !== "verb,args,status")
    failures.push(`(c) verbs/${v}.md frontmatter keys [${keys}] != [verb,args,status]`);
  const declared = fm[1].match(/^verb:\s*(\S+)/m)?.[1];
  if (declared !== v)
    failures.push(`(c) verbs/${v}.md declares verb '${declared}', filename says '${v}'`);

  for (const m of doc.matchAll(/`([a-z]+_[a-z_]+)\(?/g)) {
    const tool = m[1];
    if (TOOL_PREFIXES.test(tool) && !registry.has(tool))
      failures.push(`(d) verbs/${v}.md references unknown tool '${tool}'`);
  }
}

// (e) reserved set matches spec
const reservedActual = Object.fromEntries(
  reservedRows.map((r) => [r.verb, r.status.replace("reserved-", "")]));
for (const [verb, tier] of Object.entries(SPEC_RESERVED)) {
  if (!(verb in reservedActual))
    failures.push(`(e) spec reserved verb '${verb}' missing from routing table`);
  else if (reservedActual[verb] !== tier)
    failures.push(`(e) '${verb}' reserved for tier '${reservedActual[verb]}', spec says '${tier}'`);
}
for (const verb of Object.keys(reservedActual)) {
  if (!(verb in SPEC_RESERVED))
    failures.push(`(e) routing table reserves '${verb}' which is not in the spec list`);
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-surface: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-surface: clean — ${liveRows.length} live, ${reservedRows.length} reserved, ${registry.size} server tools`);
