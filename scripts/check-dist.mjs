#!/usr/bin/env node

// Committed-dist freshness check, install-free tier (issue #139).
// Marketplace installs run the committed server/dist — a commit that edits
// server/src and skips the rebuild ships a server that silently lags its
// source. CI's authoritative gate is the rebuild-and-diff step in ci.yml
// (npm ci + npm run build + git diff), but that needs a full install; this
// script is the fast triage tier that runs anywhere in <10s with nothing
// but git and node. Two deterministic checks against committed state:
//   (a) pairing — every tracked server/src/**/*.ts has its tracked
//       dist/<rel>.js + dist/<rel>.d.ts (tsc declaration build), and no
//       tracked dist .js/.d.ts is an orphan whose src file is gone
//   (b) ordering — no tracked src .ts differs between HEAD and the tree of
//       the last commit that touched server/dist. If src moved after the
//       last dist commit, nobody rebuilt.
//
// Chosen tradeoff, honestly: (b) reasons from git shape, not build output.
// It cannot see a same-commit partial rebuild (src + some hand-edited dist
// file committed together), and it will FALSE-POSITIVE on a src-only commit
// whose rebuild is byte-identical (pure reformat — tsc reprints output, so
// this is rare); resolution there is folding the reformat into a commit
// that also touches dist, or leaning on the rebuild-and-diff CI step, which
// remains the ground truth for both gaps. In exchange: deterministic, zero
// dependencies, no npm install, runs in well under 10s. Needs real history
// — a shallow clone is failed loudly rather than silently passed (CI
// checkout must use fetch-depth: 0).
// Exit 0 clean, exit 1 with one line per failure.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// --- helpers -----------------------------------------------------------------

function git(...args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
}

// --- inputs ------------------------------------------------------------------

if (git("rev-parse", "--is-shallow-repository") === "true") {
  console.error("check-dist: shallow clone — the ordering check needs full history (checkout with fetch-depth: 0)");
  process.exit(1);
}

const tracked = git("ls-files", "-z", "server/src", "server/dist")
  .split("\0").filter(Boolean);
const srcFiles = tracked.filter((f) => f.startsWith("server/src/") && f.endsWith(".ts"));
const distFiles = new Set(tracked.filter((f) => f.startsWith("server/dist/")));

if (srcFiles.length === 0) failures.push("no tracked .ts files under server/src");

// --- (a) pairing -------------------------------------------------------------

const expectedDist = new Set();
for (const src of srcFiles) {
  const rel = src.slice("server/src/".length).replace(/\.ts$/, "");
  for (const ext of [".js", ".d.ts"]) {
    const dist = `server/dist/${rel}${ext}`;
    expectedDist.add(dist);
    if (!distFiles.has(dist))
      failures.push(`${src} has no committed ${dist} — rebuild and commit server/dist`);
  }
}
for (const dist of distFiles) {
  if (/\.(js|d\.ts)$/.test(dist) && !expectedDist.has(dist))
    failures.push(`${dist} is an orphan (no matching server/src .ts) — rebuild and commit server/dist`);
}

// --- (b) ordering ------------------------------------------------------------

const lastDist = git("log", "-1", "--format=%H", "--", "server/dist");
if (!lastDist) {
  failures.push("no commit touches server/dist at all");
} else {
  const stale = git("diff", "--name-only", lastDist, "HEAD", "--", "server/src")
    .split("\n").filter((f) => f.endsWith(".ts"));
  for (const f of stale)
    failures.push(`${f} changed after the last dist commit (${lastDist.slice(0, 7)}) — rebuild and commit server/dist`);
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-dist: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-dist: clean — ${srcFiles.length} src files paired in dist, none newer than the last dist commit (${lastDist.slice(0, 7)})`);
