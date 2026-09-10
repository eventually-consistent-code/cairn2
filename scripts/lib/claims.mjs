// Shared mechanical-claims compute (#127, #148).
// One source of truth for every countable public claim — verb count/list,
// typed-tool count, tracker/docs adapter lists, release version — plus the
// <!-- auto:name --> span-rewrite machinery both refresher scripts run.
// refresh-readme.mjs and refresh-comparison.mjs import from here, so the
// README and the comparison page can never disagree about a number.
//
// Same sources check-surface.mjs trusts: the SKILL.md routing table, the
// server registry in server/src/index.ts, and the adapter directories.

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// --- display helpers ---------------------------------------------------------

// adapter dirs -> display names. The SET is computed from the filesystem (a
// new adapter file changes the output); the name map + preferred order are
// display choices only. Unknown newcomers fall back to Title-Cased filenames
// and append after the known ones.
const DISPLAY = {
  asana: "Asana", "azure-boards": "Azure Boards", clickup: "ClickUp",
  github: "GitHub", gitlab: "GitLab", jira: "Jira", linear: "Linear",
  local: "local files", confluence: "Confluence", docusaurus: "Docusaurus",
};
const TRACKER_ORDER = ["github", "gitlab", "jira", "asana", "azure-boards", "clickup", "linear", "local"];

// small counts read better as words ("eight adapters", not "8 adapters")
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "eleven", "twelve"];
export const word = (n) => WORDS[n] ?? String(n);
export const capWord = (n) => { const w = word(n); return w[0].toUpperCase() + w.slice(1); };
export const prose = (names) => names.length === 2
  ? names.join(" and ")
  : names.slice(0, -1).join(", ") + ", and " + names.at(-1);
export function displayName(slug) {
  return DISPLAY[slug]
    ?? slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// --- compute the claims ------------------------------------------------------

/**
 * Compute every mechanically-derivable claim from the repo at `root`.
 * Returns { liveVerbs, toolCount, trackerSlugs, docsSlugs, version, failures }.
 */
export function computeClaims(root) {
  const failures = [];

  // live verbs: same strict row regex as check-surface.mjs, so the scripts
  // can never disagree about what counts as a live verb.
  const skillMd = readFileSync(
    join(root, "skills/cairn-trailhead/SKILL.md"), "utf8");
  const liveVerbs = [];
  for (const line of skillMd.split("\n")) {
    const m = line.match(
      /^\|\s*`([a-z]+)`\s*\|.*\|\s*(verbs\/[a-z]+\.md)\s*\|\s*(live|reserved-[A-F0-9]+)\s*\|\s*$/);
    if (m && m[3] === "live") liveVerbs.push(m[1]);
  }
  liveVerbs.sort();
  if (liveVerbs.length === 0) failures.push("no live routing-table rows parsed from SKILL.md");

  // server tools: same registry build as check-surface.mjs — registerTool()
  // literals plus the registerSessionTools() factory expansion.
  const serverSrc = readFileSync(join(root, "server/src/index.ts"), "utf8");
  const registry = new Set(
    [...serverSrc.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  for (const m of serverSrc.matchAll(/registerSessionTools\("([a-z]+)"/g)) {
    for (const suffix of ["start", "log", "close"]) registry.add(`${m[1]}_${suffix}`);
  }
  if (registry.size === 0) failures.push("no registerTool() names found in server/src/index.ts");

  const adapterSlugs = (dir) => readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""));

  const trackerSlugs = adapterSlugs("server/src/tracker/adapters");
  trackerSlugs.sort((a, b) => {
    const ia = TRACKER_ORDER.indexOf(a), ib = TRACKER_ORDER.indexOf(b);
    return (ia === -1 ? TRACKER_ORDER.length : ia) - (ib === -1 ? TRACKER_ORDER.length : ib)
      || a.localeCompare(b);
  });
  const docsSlugs = adapterSlugs("server/src/docs/adapters").sort();
  if (trackerSlugs.length === 0) failures.push("no tracker adapters found in server/src/tracker/adapters/");
  if (docsSlugs.length === 0) failures.push("no docs adapters found in server/src/docs/adapters/");

  // release version: the root manifest is the plugin's public version, and
  // check-versions.mjs already gates it against server/package.json.
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")).version;
  if (!version) failures.push("no version field in package.json");

  return { liveVerbs, toolCount: registry.size, trackerSlugs, docsSlugs, version, failures };
}

// --- rewrite between markers -------------------------------------------------

/**
 * Replace every <!-- auto:name -->…<!-- /auto:name --> span in `text` with
 * the rendered content from `spans`. Returns { proposed, failures }.
 */
export function applySpans(text, spans) {
  const failures = [];
  let proposed = text;
  for (const [name, content] of Object.entries(spans)) {
    const re = new RegExp(
      `<!-- auto:${name} -->[\\s\\S]*?<!-- /auto:${name} -->`, "g");
    if (!proposed.match(re)) { failures.push(`marker pair <!-- auto:${name} --> not found`); continue; }
    proposed = proposed.replace(re, `<!-- auto:${name} -->${content}<!-- /auto:${name} -->`);
  }
  return { proposed, failures };
}

// --- report / apply ----------------------------------------------------------

/**
 * Shared exit protocol: clean -> exit 0, --write -> apply in place, otherwise
 * print a unified diff and exit 1 so CI can gate on it. Never returns.
 */
export function reportOrApply({ label, filePath, original, proposed, write, summary }) {
  const fileName = filePath.split("/").at(-1);
  if (proposed === original) {
    console.log(`${label}: clean — ${summary}`);
    process.exit(0);
  }

  if (write) {
    writeFileSync(filePath, proposed);
    console.log(`${label}: ${fileName} updated — ${summary}`);
    process.exit(0);
  }

  // stale: propose as a unified diff (git renders it; --no-index needs no repo
  // state) and exit 1 so CI can gate on it.
  const tmp = mkdtempSync(join(tmpdir(), `${label}-`));
  try {
    const proposedPath = join(tmp, fileName);
    writeFileSync(proposedPath, proposed);
    const r = spawnSync("git",
      ["-c", "core.pager=cat", "diff", "--no-index", "--", filePath, proposedPath],
      { encoding: "utf8" });
    process.stdout.write(r.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.error(`${label}: ${fileName} stale — run with --write to apply`);
  process.exit(1);
}
