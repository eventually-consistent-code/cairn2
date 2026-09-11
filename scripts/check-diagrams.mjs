#!/usr/bin/env node

// Diagram-label count guard (issue #154).
// The architecture diagrams in docs/diagrams/ carry counted claims ("84
// typed MCP tools", "39 subroutines", "8 backends") baked into their
// .excalidraw label text. Those numbers drifted from the live registry
// three times (37/71 -> 79 -> 84) before anyone noticed — the PNGs look
// fine in review no matter what the counts say. This check:
//   (a) computes the live counts via the shared claims module
//       (scripts/lib/claims.mjs — same sources check-surface.mjs and the
//       README refresher trust, so no number can disagree across scripts)
//   (b) sweeps every text / originalText field in docs/diagrams/*.excalidraw
//       for count-shaped label fragments and fails any whose N disagrees
//       with the live value.
//
// Patterns (kept deliberately narrow — diagrams hold plenty of innocent
// numerics like ports, JSON payloads, and issue keys):
//   "N typed MCP tools" / "N typed tools"  -> live tool count
//   "N generated verb shims"               -> live verb count
//   "N subroutines"                        -> live verb count
//   "N backends"                           -> tracker adapter count
//   "N docs adapters"                      -> docs adapter count
//   "N adapters" / "N tracker adapters"    -> tracker adapter count
//
// Deliberately excluded (not registry-computable from source):
//   "683 assertions shared" — a runtime vitest tally from executing the
//     contract suite across all adapters; no static parse yields it.
//   "9 honest flags" — a TS interface field count outside claims.mjs's
//     remit; add it there first if it ever drifts.
//
// Detection only: the Excalidraw renderer lives outside this repo, so a
// failure here means edit the .excalidraw source, re-render the PNG
// externally, and commit both (see docs/diagrams/README.md).
// Exit 0 clean, exit 1 with one file + label excerpt per failure.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { computeClaims } from "./lib/claims.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// --- live counts -------------------------------------------------------------

const claims = computeClaims(root);
failures.push(...claims.failures);
const toolCount = claims.toolCount;
const verbCount = claims.liveVerbs.length;
const trackerCount = claims.trackerSlugs.length;
const docsCount = claims.docsSlugs.length;

// pattern -> expected live value. Order matters: more-specific phrasings
// ("docs adapters") sit above the generic ones they would otherwise match.
const PATTERNS = [
  { re: /(\d+)\s+typed(?:\s+MCP)?\s+tools/gi, what: "typed tools", expected: () => toolCount },
  { re: /(\d+)\s+generated\s+verb\s+shims/gi, what: "generated verb shims", expected: () => verbCount },
  { re: /(\d+)\s+subroutines/gi, what: "subroutines", expected: () => verbCount },
  { re: /(\d+)\s+backends/gi, what: "backends", expected: () => trackerCount },
  { re: /(\d+)\s+docs\s+adapters/gi, what: "docs adapters", expected: () => docsCount },
  { re: /(\d+)\s+(?:tracker\s+)?adapters/gi, what: "adapters", expected: () => trackerCount },
];

// --- sweep -------------------------------------------------------------------

const diagramsDir = join(root, "docs/diagrams");
const sources = readdirSync(diagramsDir).filter((f) => f.endsWith(".excalidraw")).sort();
if (sources.length === 0) failures.push("no .excalidraw sources found in docs/diagrams/");

let labelsChecked = 0;
for (const name of sources) {
  const file = relative(root, join(diagramsDir, name));
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(diagramsDir, name), "utf8"));
  } catch (e) {
    failures.push(`${file} is not valid JSON (${e.message})`);
    continue;
  }

  // text and originalText usually carry the same words (originalText is the
  // pre-wrap form) — dedupe per element so one bad label fails once.
  const seen = new Set();
  for (const el of doc.elements ?? []) {
    for (const key of ["text", "originalText"]) {
      const label = el[key];
      if (typeof label !== "string") continue;
      for (const { re, what, expected } of PATTERNS) {
        for (const m of label.matchAll(re)) {
          const n = Number(m[1]);
          const want = expected();
          const excerpt = m[0].slice(0, 40);
          const dedupe = `${el.id ?? key}|${what}|${excerpt}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          labelsChecked++;
          if (n !== want)
            failures.push(
              `${file}: label "${excerpt}" pins ${what} at ${n}, live value is ${want}` +
              ` — fix the .excalidraw source, then re-render the PNG (renderer lives` +
              ` outside this repo; this check detects only)`);
        }
      }
    }
  }
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-diagrams: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-diagrams: clean — ${labelsChecked} count-shaped label(s) across ${sources.length} diagram(s)` +
  ` agree (tools ${toolCount}, verbs ${verbCount}, trackers ${trackerCount}, docs ${docsCount})`);
