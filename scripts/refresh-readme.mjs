#!/usr/bin/env node

// README mechanical-claims refresher (#127).
// The README's countable claims (verb count/list, tool count, tracker/docs
// adapter lists) drift every release. The compute lives in lib/claims.mjs —
// shared with refresh-comparison.mjs so the two pages can never disagree —
// and this script rewrites ONLY the spans between explicit HTML comment
// markers in README.md:
//
//   <!-- auto:verbs -->…<!-- /auto:verbs -->                 verb count + list
//   <!-- auto:tool-count -->…<!-- /auto:tool-count -->       typed MCP tool count
//   <!-- auto:trackers -->…<!-- /auto:trackers -->           tracker backend blurb
//   <!-- auto:tracker-count -->…<!-- /auto:tracker-count --> tracker adapter count word
//   <!-- auto:docs-connectors -->…<!-- /auto:docs-connectors --> docs connector list
//
// Default mode: print a unified diff to stdout and exit 1 if stale, exit 0 if
// clean (CI-gateable). `--write` applies the refresh in place. The script
// never rewrites silently by default — propose-as-diff is the human gate.
//
// Deliberately NOT automated: the "N passing tests" claim. Counting tests
// needs a full vitest run — too slow for a claims script — so that number
// stays hand-maintained next to the tool count.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeClaims, applySpans, reportOrApply, capWord, word, prose, displayName }
  from "./lib/claims.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

// --- compute + render the spans ----------------------------------------------

const { liveVerbs, toolCount, trackerSlugs, docsSlugs, failures } = computeClaims(root);

// verb list: backticked, alphabetical, wrapped to README's ~78-column grain
function wrapVerbs(verbs) {
  const lines = [`**Verbs (${verbs.length} live):**`];
  for (const v of verbs) {
    const token = `\`${v}\``;
    if (lines.at(-1).length + 1 + token.length > 78) lines.push(token);
    else lines[lines.length - 1] += ` ${token}`;
  }
  return lines.join("\n");
}

const spans = {
  "verbs": wrapVerbs(liveVerbs),
  "tool-count": String(toolCount),
  "trackers": `${capWord(trackerSlugs.length)} write-through backends `
    + `(${trackerSlugs.map(displayName).join(", ")})`,
  "tracker-count": word(trackerSlugs.length),
  "docs-connectors": prose(docsSlugs.map(displayName)),
};

// --- rewrite between markers -------------------------------------------------

const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
const { proposed, failures: spanFailures } = applySpans(readme, spans);
failures.push(...spanFailures.map((f) => `${f} in README.md`));

if (failures.length) {
  console.error(`refresh-readme: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

// --- report / apply ----------------------------------------------------------

reportOrApply({
  label: "refresh-readme", filePath: readmePath, original: readme, proposed, write,
  summary: `${liveVerbs.length} verbs, ${toolCount} tools, `
    + `${trackerSlugs.length} tracker adapters, ${docsSlugs.length} docs connectors`,
});
