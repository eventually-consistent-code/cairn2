#!/usr/bin/env node

// Release version bump (#80 — one command bumps every version surface).
// Bumps all three version files in one shot so they can never drift apart:
//   package.json, server/package.json, .claude-plugin/plugin.json
// and prepends a scaffold entry to CHANGELOG.md (heading + date + a
// fill-me-in bullet — content stays human-written).
//   node scripts/release.mjs 2.3.0     explicit target version
//   node scripts/release.mjs patch     2.2.0 -> 2.2.1
//   node scripts/release.mjs minor     2.2.0 -> 2.3.0
//   node scripts/release.mjs major     2.2.0 -> 3.0.0
// Refuses to run when the three files already disagree — pre-existing drift
// means a human decides which version is right, not this script. Everything
// is validated before the first write, so either all four files land or
// none do. No git operations here: commit and tag stay with the human
// (publish.yml gates the tag against these versions on push).
// Exit 0 clean, exit 1 with the reason.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const VERSION_FILES = [
  "package.json",
  "server/package.json",
  ".claude-plugin/plugin.json",
];
const CHANGELOG = "CHANGELOG.md";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const BUMPS = ["patch", "minor", "major"];

function die(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

// --- argument ----------------------------------------------------------------

const arg = process.argv[2];
if (!arg || process.argv.length > 3) {
  console.error("usage: node scripts/release.mjs <version | patch | minor | major>");
  process.exit(1);
}
if (!BUMPS.includes(arg) && !SEMVER.test(arg)) {
  die(`'${arg}' is not a semver version (X.Y.Z) or one of: ${BUMPS.join(", ")}`);
}

// --- read the three version surfaces -----------------------------------------

const surfaces = VERSION_FILES.map((rel) => {
  const path = join(root, rel);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die(`cannot read ${rel}`);
  }
  let version;
  try {
    version = JSON.parse(raw).version;
  } catch {
    die(`${rel} is not valid JSON`);
  }
  if (!version || !SEMVER.test(version)) {
    die(`${rel} has no valid "version" field ('${version}')`);
  }
  return { rel, path, raw, version };
});

// --- refusal path: pre-existing drift is a human's call -----------------------

const current = surfaces[0].version;
if (surfaces.some((s) => s.version !== current)) {
  console.error("release: the version files already disagree — fix that by hand first:");
  for (const s of surfaces) {
    console.error(`  ${s.rel.padEnd(28)} ${s.version}`);
  }
  process.exit(1);
}

// --- compute the target version ----------------------------------------------

let next;
if (BUMPS.includes(arg)) {
  const [major, minor, patch] = current.split(/[.-]/).slice(0, 3).map(Number);
  if (arg === "major") next = `${major + 1}.0.0`;
  else if (arg === "minor") next = `${major}.${minor + 1}.0`;
  else next = `${major}.${minor}.${patch + 1}`;
} else {
  next = arg;
}
if (next === current) {
  die(`already at ${current} — nothing to bump`);
}

// --- validate every write before the first one lands --------------------------

// version files: swap the exact `"version": "<current>"` literal so the rest
// of each file's formatting is untouched.
const needle = `"version": "${current}"`;
for (const s of surfaces) {
  if (s.raw.indexOf(needle) === -1) {
    die(`${s.rel} does not contain ${needle} verbatim — bump it by hand`);
  }
  s.next = s.raw.replace(needle, `"version": "${next}"`);
}

// changelog: prepend a scaffold entry above the newest `## v...` heading,
// matching the house style (## vX.Y.Z — headline (YYYY-MM-DD) + bullets).
const changelogPath = join(root, CHANGELOG);
let changelog;
try {
  changelog = readFileSync(changelogPath, "utf8");
} catch {
  die(`cannot read ${CHANGELOG}`);
}
if (changelog.includes(`## v${next} `) || changelog.includes(`## v${next}—`)) {
  die(`${CHANGELOG} already has a v${next} entry`);
}
const entryIdx = changelog.indexOf("\n## v");
if (entryIdx === -1) {
  die(`${CHANGELOG} has no '## v...' entry to scaffold above`);
}
const today = new Date().toISOString().slice(0, 10);
const scaffold = [
  `## v${next} — <headline> (${today})`,
  "",
  "- <what shipped — fill in before tagging>",
  "",
  "",
].join("\n");
const nextChangelog =
  changelog.slice(0, entryIdx + 1) + scaffold + changelog.slice(entryIdx + 1);

// --- write everything, roll back if anything lands partway --------------------

console.log(`bumping ${current} -> ${next}...`);
const written = [];
try {
  for (const s of surfaces) {
    writeFileSync(s.path, s.next);
    written.push(s);
    console.log(`  ${s.rel.padEnd(28)} ${current} -> ${next}`);
  }
  writeFileSync(changelogPath, nextChangelog);
  console.log(`  ${CHANGELOG.padEnd(28)} scaffold entry prepended`);
} catch (err) {
  for (const s of written) writeFileSync(s.path, s.raw);
  die(`write failed (${err.message}) — version files rolled back`);
}

console.log(`release surfaces bumped — v${next} across ${VERSION_FILES.length} files + changelog scaffold.`);
console.log(`next: fill in the CHANGELOG bullets, commit, tag v${next}.`);
