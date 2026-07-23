#!/usr/bin/env node

// Command-shim generator (P5″ per-verb surface).
// Reads the canonical routing table in skills/cairn-trailhead/SKILL.md and
// writes one thin command shim per `live` verb into commands/, so the typed
// surface is /cairn:<verb> [args]. check-surface.mjs check (f) enforces the
// commands/ dir stays exactly in sync with the table — regenerate, never
// hand-edit shims.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "\u0001"; // stand-in for escaped pipes while cell-splitting

console.log("generating command shims...");

// --- parse the routing table -------------------------------------------------

const skillMd = readFileSync(
  join(root, "skills/cairn-trailhead/SKILL.md"), "utf8");

// routing table rows: | `verb` | purpose | args | verbs/<verb>.md | status |
const rows = [];
for (const line of skillMd.split("\n")) {
  if (!/^\|\s*`[a-z]+`\s*\|/.test(line)) continue;
  const cells = line
    .replaceAll("\\|", SENTINEL)
    .split("|")
    .map((c) => c.replaceAll(SENTINEL, "|").trim());
  // cells: ["", `verb`, purpose, args, subroutine, status, ""]
  if (cells.length < 6) continue;
  const verb = cells[1].replaceAll("`", "");
  const status = cells[5];
  if (status !== "live") continue;
  rows.push({ verb, purpose: cells[2], args: cells[3].replaceAll("`", "") });
}

if (rows.length === 0) {
  console.error("no live routing-table rows parsed — aborting");
  process.exit(1);
}

// --- write one shim per live verb --------------------------------------------

for (const { verb, purpose, args } of rows) {
  const fm = [
    "---",
    `description: ${JSON.stringify(`${purpose} (cairn — /cairn:help for the verb reference)`)}`,
  ];
  if (args) fm.push(`argument-hint: ${JSON.stringify(args)}`);
  fm.push("---");

  const body = [
    "",
    `Execute the cairn verb \`${verb}\`:`,
    "",
    "1. Read `skills/cairn-trailhead/SKILL.md` (this plugin) — its shared",
    "   rules apply to every step below.",
    `2. Read \`skills/cairn-trailhead/verbs/${verb}.md\` and execute it with`,
    "   `$ARGUMENTS` as its arguments.",
    "",
  ];

  writeFileSync(join(root, `commands/${verb}.md`), fm.concat(body).join("\n"));
}

// --- sweep stale shims (files with no live row) -------------------------------

const live = new Set(rows.map((r) => r.verb));
for (const f of readdirSync(join(root, "commands"))) {
  if (!f.endsWith(".md")) continue;
  const name = f.replace(/\.md$/, "");
  if (!live.has(name)) {
    unlinkSync(join(root, "commands", f));
    console.log(`  removed stale commands/${f}`);
  }
}

console.log(`command shims generated — ${rows.length} live verbs.`);
