#!/usr/bin/env node

// README mechanical-claims refresher (#127).
// The README's countable claims (verb count/list, tool count, tracker/docs
// adapter lists) drift every release. This script computes each one from the
// same sources check-surface.mjs trusts — the SKILL.md routing table, the
// server registry in server/src/index.ts, and the adapter directories — and
// rewrites ONLY the spans between explicit HTML comment markers in README.md:
//
//   <!-- auto:verbs -->…<!-- /auto:verbs -->                 verb count + list
//   <!-- auto:tool-count -->…<!-- /auto:tool-count -->       typed MCP tool count
//   <!-- auto:test-count -->…<!-- /auto:test-count -->       passing-test count (see below)
//   <!-- auto:trackers -->…<!-- /auto:trackers -->           tracker backend blurb
//   <!-- auto:tracker-count -->…<!-- /auto:tracker-count --> tracker adapter count word
//   <!-- auto:docs-connectors -->…<!-- /auto:docs-connectors --> docs connector list
//   <!-- auto:harness-count -->…<!-- /auto:harness-count --> non-Claude harness count word
//   <!-- auto:harness-list -->…<!-- /auto:harness-list -->   non-Claude harness display list
//   <!-- auto:agent-count -->…<!-- /auto:agent-count -->     agents/ *.md file count
//   <!-- auto:deps -->…<!-- /auto:deps -->                   server runtime dependency blurb
//
// Default mode: print a unified diff to stdout and exit 1 if stale, exit 0 if
// clean (CI-gateable). `--write` applies the refresh in place. The script
// never rewrites silently by default — propose-as-diff is the human gate.
//
// The "N passing tests" claim (#147): counted with `npx vitest list --json`
// in server/ — vitest's own enumeration, no suite run. The listing omits the
// env-gated live-backend suites (without CAIRN_LIVE_TESTS creds each defines
// only an it.skip placeholder, and `vitest list` doesn't list skipped tests),
// so the number equals exactly the "N passed" of a credential-less
// `vitest run` — the same run CI does. Cost: ~2-3s and it needs
// server/node_modules (`npm ci` in server/ first); it runs in every mode,
// because the default diff mode can't detect staleness without the real
// number. If CI ever gates on this script, run it after the server test step
// so node_modules already exists.

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const failures = [];

// --- compute the claims ------------------------------------------------------

// live verbs: same strict row regex as check-surface.mjs, so the two scripts
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

function adapterSlugs(dir) {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""));
}
function displayName(slug) {
  return DISPLAY[slug]
    ?? slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const trackerSlugs = adapterSlugs("server/src/tracker/adapters");
trackerSlugs.sort((a, b) => {
  const ia = TRACKER_ORDER.indexOf(a), ib = TRACKER_ORDER.indexOf(b);
  return (ia === -1 ? TRACKER_ORDER.length : ia) - (ib === -1 ? TRACKER_ORDER.length : ib)
    || a.localeCompare(b);
});
const docsSlugs = adapterSlugs("server/src/docs/adapters").sort();
if (trackerSlugs.length === 0) failures.push("no tracker adapters found in server/src/tracker/adapters/");
if (docsSlugs.length === 0) failures.push("no docs adapters found in server/src/docs/adapters/");

// test count: vitest's own enumeration (see header) — equals the passed
// count of a credential-less run because the live-suite skip stubs are
// never listed.
let testCount = 0;
const listRun = spawnSync("npx", ["vitest", "list", "--json"],
  { cwd: join(root, "server"), encoding: "utf8" });
if (listRun.status !== 0 || listRun.error) {
  failures.push("`npx vitest list` failed in server/ — run `npm ci` there first"
    + (listRun.stderr ? ` (${listRun.stderr.trim().split("\n").at(-1)})` : ""));
} else {
  try { testCount = JSON.parse(listRun.stdout.trim()).length; }
  catch { failures.push("vitest list --json output was not parseable JSON"); }
  if (testCount === 0) failures.push("vitest list enumerated zero tests");
}

// other harnesses: the installer's own HARNESSES registry minus claude
// (README speaks of "N *other* AI CLI harnesses"). Display names are a
// presentation map; unknown newcomers fall back to Title-Cased slugs.
const HARNESS_DISPLAY = {
  grok: "Grok Build", copilot: "Copilot CLI", codex: "Codex",
  gemini: "Gemini CLI", cursor: "Cursor", opencode: "OpenCode", zed: "Zed",
};
const setupSrc = readFileSync(join(root, "setup/cairn-setup.mjs"), "utf8");
const hm = setupSrc.match(/const HARNESSES = \[([^\]]*)\]/);
const otherHarnesses = (hm ? [...hm[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]) : [])
  .filter((h) => h !== "claude");
if (otherHarnesses.length === 0) failures.push("no HARNESSES parsed from setup/cairn-setup.mjs");

// agents: one .md per agent in the plugin's agents/ dir
const agentCount = readdirSync(join(root, "agents"))
  .filter((f) => f.endsWith(".md")).length;
if (agentCount === 0) failures.push("no agent files found in agents/");

// server runtime dependencies, straight from the manifest
const deps = Object.keys(JSON.parse(
  readFileSync(join(root, "server/package.json"), "utf8")).dependencies ?? {}).sort();
if (deps.length === 0) failures.push("no dependencies found in server/package.json");

// small counts read better as words ("eight adapters", not "8 adapters")
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "eleven", "twelve"];
const word = (n) => WORDS[n] ?? String(n);
const capWord = (n) => { const w = word(n); return w[0].toUpperCase() + w.slice(1); };
const prose = (names) => names.length === 2
  ? names.join(" and ")
  : names.slice(0, -1).join(", ") + ", and " + names.at(-1);

// --- render the spans --------------------------------------------------------

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

// space-separated tokens wrapped to the same ~78-column grain
function wrapProse(text, width = 78) {
  const lines = [""];
  for (const tok of text.split(" ")) {
    if (lines.at(-1) && lines.at(-1).length + 1 + tok.length > width) lines.push(tok);
    else lines[lines.length - 1] = lines.at(-1) ? `${lines.at(-1)} ${tok}` : tok;
  }
  return lines.join("\n");
}

const spans = {
  "verbs": wrapVerbs(liveVerbs),
  "tool-count": String(registry.size),
  "test-count": String(testCount),
  "trackers": `${capWord(trackerSlugs.length)} write-through backends `
    + `(${trackerSlugs.map(displayName).join(", ")})`,
  "tracker-count": word(trackerSlugs.length),
  "docs-connectors": prose(docsSlugs.map(displayName)),
  "harness-count": word(otherHarnesses.length),
  "harness-list": otherHarnesses
    .map((h) => HARNESS_DISPLAY[h] ?? displayName(h)).join(", "),
  "agent-count": String(agentCount),
  "deps": `${word(deps.length)} dependencies\n`
    + wrapProse(`(${deps.map((d) => `\`${d}\``).join(", ")})`),
};

// --- rewrite between markers -------------------------------------------------

const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
let proposed = readme;

for (const [name, content] of Object.entries(spans)) {
  const re = new RegExp(
    `<!-- auto:${name} -->[\\s\\S]*?<!-- /auto:${name} -->`, "g");
  const hits = proposed.match(re);
  if (!hits) { failures.push(`marker pair <!-- auto:${name} --> not found in README.md`); continue; }
  proposed = proposed.replace(re, `<!-- auto:${name} -->${content}<!-- /auto:${name} -->`);
}

if (failures.length) {
  console.error(`refresh-readme: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

// --- report / apply ----------------------------------------------------------

const summary = `${liveVerbs.length} verbs, ${registry.size} tools, `
  + `${testCount} tests, ${trackerSlugs.length} tracker adapters, `
  + `${docsSlugs.length} docs connectors, ${otherHarnesses.length} other harnesses, `
  + `${agentCount} agents, ${deps.length} deps`;

if (proposed === readme) {
  console.log(`refresh-readme: clean — ${summary}`);
  process.exit(0);
}

if (write) {
  writeFileSync(readmePath, proposed);
  console.log(`refresh-readme: README.md updated — ${summary}`);
  process.exit(0);
}

// stale: propose as a unified diff (git renders it; --no-index needs no repo
// state) and exit 1 so CI can gate on it.
const tmp = mkdtempSync(join(tmpdir(), "refresh-readme-"));
try {
  const proposedPath = join(tmp, "README.md");
  writeFileSync(proposedPath, proposed);
  const r = spawnSync("git",
    ["-c", "core.pager=cat", "diff", "--no-index", "--", readmePath, proposedPath],
    { encoding: "utf8" });
  process.stdout.write(r.stdout);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.error("refresh-readme: README.md stale — run scripts/refresh-readme.mjs --write to apply");
process.exit(1);
