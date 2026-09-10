#!/usr/bin/env node

// Comparison-page mechanical-claims refresher (#148).
// docs/comparison.md states cairn's own numbers (version, verb count, typed
// tool count, tracker backends) — the one column on that page we can compute
// instead of asserting. The compute lives in lib/claims.mjs, shared with
// refresh-readme.mjs, so the README and the comparison page can never
// disagree. This script rewrites ONLY the spans between markers in
// docs/comparison.md:
//
//   <!-- auto:version -->…<!-- /auto:version -->             release version (package.json)
//   <!-- auto:verb-count -->…<!-- /auto:verb-count -->       live verb count
//   <!-- auto:tool-count -->…<!-- /auto:tool-count -->       typed MCP tool count
//   <!-- auto:tracker-count -->…<!-- /auto:tracker-count --> tracker backend count (digit)
//   <!-- auto:trackers-cell -->…<!-- /auto:trackers-cell --> backend list, table-cell wording
//
// Competitor rows stay hand-verified on purpose — a script can't attest to
// someone else's mechanisms, only a dated human pass can. Same for the "N
// passing tests" number (needs a full vitest run; hand-maintained, same
// policy as the README).
//
// Default mode: unified diff + exit 1 if stale, exit 0 if clean (CI-gateable).
// `--write` applies in place.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeClaims, applySpans, reportOrApply, displayName } from "./lib/claims.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

// --- compute + render the spans ----------------------------------------------

const { liveVerbs, toolCount, trackerSlugs, version, failures } = computeClaims(root);

// table-cell wording keeps the page's own emphasis for the local backend —
// "zero-credential local" is the mechanism being claimed, not just a name.
const cellName = (slug) => slug === "local" ? "zero-credential local" : displayName(slug);

const spans = {
  "version": version,
  "verb-count": String(liveVerbs.length),
  "tool-count": String(toolCount),
  "tracker-count": String(trackerSlugs.length),
  "trackers-cell": `${trackerSlugs.length} write-through backends `
    + `(${trackerSlugs.map(cellName).join(", ")})`,
};

// --- rewrite between markers -------------------------------------------------

const pagePath = join(root, "docs/comparison.md");
const page = readFileSync(pagePath, "utf8");
const { proposed, failures: spanFailures } = applySpans(page, spans);
failures.push(...spanFailures.map((f) => `${f} in docs/comparison.md`));

if (failures.length) {
  console.error(`refresh-comparison: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

// --- report / apply ----------------------------------------------------------

reportOrApply({
  label: "refresh-comparison", filePath: pagePath, original: page, proposed, write,
  summary: `v${version}, ${liveVerbs.length} verbs, ${toolCount} tools, `
    + `${trackerSlugs.length} tracker backends`,
});
