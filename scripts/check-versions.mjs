#!/usr/bin/env node

// Version-sync check (issue #79).
// Three files each carry a version and all three ship together:
//   package.json (the plugin npm package), server/package.json (the MCP
//   server npm package), and .claude-plugin/plugin.json (the marketplace
//   manifest). The publish tag gate only fires at tag time -- this check
//   catches a half-bumped release on every main push and PR, before the
//   tag exists. plugin.json was previously checked by nothing at all.
// Extended for #83 with two more surfaces:
//   - the marketplace pin: .claude-plugin/marketplace.json distributes the
//     cairn plugin from a github source pinned to the release tag — the pin
//     must be "vX.Y.Z" and agree with the version files, or installs fetch
//     the wrong tree (or an unpinned mutable clone).
//   - runtime-dep mirroring: the plugin installer materializes node_modules
//     from the ROOT package.json + lockfile, so every server runtime dep
//     must be declared at the root with the same range — a dep added to
//     server/ but not the root ships an install that dies at startup
//     (ERR_MODULE_NOT_FOUND, the 2026-08-13 incident).
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

const MARKETPLACE = ".claude-plugin/marketplace.json";

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

// Marketplace pin: the cairn entry must be a github source pinned to the
// release tag, and that tag must agree with the version files.
try {
  const mp = JSON.parse(readFileSync(join(root, MARKETPLACE), "utf8"));
  const entry = (mp.plugins ?? []).find((p) => p.name === "cairn");
  const ref = entry?.source?.ref;
  if (typeof ref !== "string" || !/^v\d+\.\d+\.\d+/.test(ref)) {
    failures.push(`${MARKETPLACE} cairn source is not pinned to a release tag (expected "ref": "vX.Y.Z", got ${JSON.stringify(entry?.source ?? null)})`);
  } else if (reference && ref !== `v${reference}`) {
    failures.push(`${MARKETPLACE} pin is ${ref}, package.json is ${reference}`);
  }
} catch (e) {
  failures.push(`${MARKETPLACE} unreadable: ${e.message}`);
}

// Runtime-dep mirroring: every server runtime dep, same range, at the root.
try {
  const rootDeps = JSON.parse(readFileSync(join(root, FILES[0]), "utf8")).dependencies ?? {};
  const serverDeps = JSON.parse(readFileSync(join(root, FILES[1]), "utf8")).dependencies ?? {};
  for (const [dep, range] of Object.entries(serverDeps)) {
    if (!(dep in rootDeps))
      failures.push(`package.json is missing server runtime dep ${dep} — installed plugin caches won't get it`);
    else if (rootDeps[dep] !== range)
      failures.push(`package.json has ${dep}@${rootDeps[dep]}, server/package.json wants ${range}`);
  }
} catch {
  // unreadable package.json files were already reported above
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-versions: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-versions: clean — version files, marketplace pin, and runtime deps all agree on ${reference}`);
