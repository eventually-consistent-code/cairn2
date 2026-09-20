#!/usr/bin/env node

// Machine-wide plugin footprint report (context-economy-layer, task 6).
//
// check-footprint.mjs answers "what does cairn cost this session" -- but a
// measured real session carried a ~79,700-token prefix against cairn's own
// 13,712, so cairn is one plugin among many and the other ~66,000 tokens are
// not cairn's to fix. This script makes that visible: every plugin installed
// on THIS machine, ranked by what its command/skill/agent listing text costs
// resident, same estimate as check-footprint.mjs (chars / 4).
//
// It reads ~/.claude/plugins/installed_plugins.json rather than walking the
// plugin cache directly, for three reasons discovered walking this machine's
// real cache:
//   - a marketplace checkout is not a plugin directory -- one marketplace's
//     repo root itself carries agents/, commands/ and skills/ at the top;
//   - installed copies live under
//     ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, and
//     MULTIPLE versions are retained on disk -- one plugin here has 2.3.0,
//     2.4.0 and 2.7.0 sitting side by side, so a naive directory walk would
//     count it three times over;
//   - a directory walk consults nothing about what's actually installed, so
//     a stale or disabled plugin would be reported as rent nobody is paying.
// The manifest sidesteps all three: each install record's installPath points
// at exactly the one version in play, and only installed plugins appear at
// all.
//
// This is report only. It never fails a build -- cairn does not get to fail
// another plugin's CI over its own budget -- so every exit path below is 0.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** chars / 4 -- see check-footprint.mjs for why this approximation is the right one. */
const estimateTokens = (chars) => Math.ceil(chars / 4);

/** The `field:` value from a markdown file's YAML frontmatter. */
function frontmatterField(text, field) {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end === -1) return null;
  const block = text.slice(3, end);
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(block);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

// Sums the resident name + description text for every markdown file directly
// under `dir` -- a flat `*.md` (commands/, agents/, and some skills/ entries)
// or a subdirectory carrying `SKILL.md` (the usual skills/ shape).
function listingChars(dir) {
  if (!existsSync(dir)) return 0;
  let chars = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    let mdPath = null;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      mdPath = join(dir, entry.name);
    } else if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (existsSync(skillMd)) mdPath = skillMd;
    }
    if (!mdPath) continue;
    let text;
    try {
      text = readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const name = frontmatterField(text, "name") ?? entry.name.replace(/\.md$/, "");
    const description = frontmatterField(text, "description") ?? "";
    chars += `${name} ${description}`.length;
  }
  return chars;
}

// --- load the manifest --------------------------------------------------------

const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.log(`footprint-machine: no readable plugin manifest at ${manifestPath} (${e.message}).`);
  console.log("  Nothing to report -- this machine has no installed_plugins.json to read from.");
  process.exit(0);
}

if (!manifest || typeof manifest.plugins !== "object" || manifest.plugins === null) {
  console.log(`footprint-machine: ${manifestPath} did not parse into the expected { plugins: {...} } shape.`);
  console.log("  Nothing to report.");
  process.exit(0);
}

// --- measure every install ----------------------------------------------------
//
// Each key is "<plugin>@<marketplace>"; each value is an array of install
// records (a plugin can be installed at user scope AND in one or more
// projects at once). Measure the installPath of each record directly -- that
// is exactly the version in play, sidestepping every stale copy retained
// alongside it in the cache.

const userRows = [];
const projectRows = [];

for (const [key, records] of Object.entries(manifest.plugins)) {
  if (!Array.isArray(records)) continue;
  for (const rec of records) {
    const installPath = rec?.installPath;
    if (typeof installPath !== "string" || !existsSync(installPath)) continue; // gone from disk -- skip quietly

    let chars = 0;
    for (const sub of ["commands", "skills", "agents"]) chars += listingChars(join(installPath, sub));

    const row = { key, tokens: estimateTokens(chars), version: rec.version, projectPath: rec.projectPath };
    if (rec.scope === "project") projectRows.push(row);
    else userRows.push(row); // treat anything that isn't explicitly "project" as user-resident rent
  }
}

userRows.sort((a, b) => b.tokens - a.tokens);
projectRows.sort((a, b) => b.tokens - a.tokens);

// --- report --------------------------------------------------------------------

function printGroup(title, rows) {
  console.log(title);
  if (rows.length === 0) {
    console.log("  (none)");
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.key.length));
  let total = 0;
  for (const r of rows) {
    total += r.tokens;
    const label = r.projectPath ? `${r.key.padEnd(width)}  [${r.projectPath}]` : r.key.padEnd(width);
    console.log(`  ${String(r.tokens).padStart(6)} tokens (est.)  ${label}`);
  }
  console.log(`  ${"-".repeat(20)}`);
  console.log(`  ${String(total).padStart(6)} tokens (est.)  total, ${rows.length} install(s)`);
  return total;
}

console.log("footprint-machine: plugin listing footprint, ranked by estimated resident tokens\n");

const userTotal = printGroup("User-scope (resident in every session):", userRows);
console.log("");
printGroup("Project-scope (resident only in that project):", projectRows);

console.log("");
console.log("Notes:");
console.log("  - This counts command/skill/agent listing text only -- name + description");
console.log("    frontmatter, the same chars/4 estimate check-footprint.mjs uses.");
console.log("  - MCP tool schemas are resident too, and for most plugins here they are the");
console.log("    bigger cost, but they are not counted in this report -- measuring them");
console.log("    needs each plugin's server actually started, which this script does not do.");
console.log("  - scripts/check-footprint.mjs gives cairn's own full figure, schemas included.");
console.log("  - Report only: this script always exits 0 and never gates a build -- cairn");
console.log("    does not get to fail another plugin's CI over its own footprint.");
