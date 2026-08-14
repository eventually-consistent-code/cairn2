#!/usr/bin/env node

// Version-sync check (issue #79).
// Three files each carry a version and all three ship together:
//   package.json (the plugin npm package), server/package.json (the MCP
//   server npm package), and .claude-plugin/plugin.json (the marketplace
//   manifest). The publish tag gate only fires at tag time -- this check
//   catches a half-bumped release on every main push and PR, before the
//   tag exists. plugin.json was previously checked by nothing at all.
// Exit 0 clean, exit 1 with one line per failure.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// --- inputs ------------------------------------------------------------------

const FILES = [
  "package.json",
  "server/package.json",
  ".claude-plugin/plugin.json",
];

const versions = {};
for (const f of FILES) {
  try {
    const v = JSON.parse(readFileSync(join(root, f), "utf8")).version;
    if (typeof v === "string" && v.length > 0) versions[f] = v;
    else failures.push(`${f} has no version field`);
  } catch (e) {
    failures.push(`${f} unreadable: ${e.message}`);
  }
}

// --- check -------------------------------------------------------------------

// All present files must agree — report every mismatch against the root
// package.json, so a half-bumped release names exactly the stale file(s).
const reference = versions[FILES[0]];
if (reference) {
  for (const f of FILES.slice(1)) {
    if (versions[f] && versions[f] !== reference)
      failures.push(`${f} is ${versions[f]}, package.json is ${reference}`);
  }
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-versions: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-versions: clean — all three version files agree on ${reference}`);
