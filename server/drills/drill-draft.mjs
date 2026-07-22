#!/usr/bin/env node

// Purpose: Tier C2 draft drill (mechanical) — sketch session per
//          verbs/draft.md against the REAL dist server + REAL tracker:
//          shared theme created first (custom properties only), two variants
//          linking ../themes/default.css (asserted in the HTML), decision
//          entry, decision-gated close, wrap package with CSS-pattern
//          synthesis.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "draft-drill", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// -- session + first-session theme -------------------------------------------
console.log("opening draft session...");
const started = await call("draft_start", { description: "drill: dashboard density — cards or table?" });
check("draft_start: session + real cairn:sketch issue", Boolean(started.id) && Boolean(started.issue),
  JSON.stringify(started.__error ?? "").slice(0, 100));
check("sketch issue: label cairn:sketch",
  (await call("issue_get", { id: started.issue })).labels?.includes("cairn:sketch"));

await call("issue_comment", { id: started.issue,
  text: "Investigation started: sketching the dashboard two ways — dense card grid vs a flat table — so we can pick a direction by looking, not arguing." });

const themeDir = join(PROJECT, ".cairn", "draft", "themes");
mkdirSync(themeDir, { recursive: true });
const THEME = [":root {", "  --color-bg: #fafafa;", "  --color-surface: #ffffff;",
  "  --color-text: #1a1a1a;", "  --color-primary: #2563eb;",
  "  --font-sans: system-ui, sans-serif;", "  --space-2: 0.5rem;", "  --space-4: 1rem;",
  "  --radius: 6px;", "}", ""].join("\n");
writeFileSync(join(themeDir, "default.css"), THEME);
const theme = readFileSync(join(themeDir, "default.css"), "utf8");
check("theme: custom properties only — no selectors beyond :root, no layout",
  /^:root \{/.test(theme) && !/display:|grid-template|margin:|\.[a-z]/.test(theme));

// -- two variants, both linking the shared theme ------------------------------
const variantDir = join(PROJECT, ".cairn", "draft", started.id);
mkdirSync(variantDir, { recursive: true });
const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<link rel="stylesheet" href="../themes/default.css">
<style>body{font-family:var(--font-sans);background:var(--color-bg);color:var(--color-text)}</style>
</head><body>${body}</body></html>\n`;
writeFileSync(join(variantDir, "001-cards.html"), page("Cards", "<main class=\"cards\">card grid variant</main>"));
writeFileSync(join(variantDir, "002-table.html"), page("Table", "<main class=\"table\">flat table variant</main>"));

for (const f of ["001-cards.html", "002-table.html"]) {
  const html = readFileSync(join(variantDir, f), "utf8");
  check(`variant ${f}: links ../themes/default.css`, html.includes('href="../themes/default.css"'));
}

await call("draft_log", { id: started.id, kind: "variant",
  text: "001-cards.html — does a dense card grid read faster than a table at 50 items?" });
await call("draft_log", { id: started.id, kind: "variant",
  text: "002-table.html — same 50 items as a flat sortable table." });
await call("draft_log", { id: started.id, kind: "note",
  text: "both variants share the default theme; only structure differs, so the comparison is honest." });

// -- decision gate ------------------------------------------------------------
const early = await call("draft_close", { id: started.id, resolution: "cards" });
check("decision gate: close without decision refused", Boolean(early.__error));

await call("draft_log", { id: started.id, kind: "decision",
  text: "card grid wins — faster scan at 50 items; keep table for the export view only." });
await call("issue_comment", { id: started.issue,
  text: "Decision: the card grid reads faster at fifty items, so that is the dashboard direction. Tables stay for the export view." });

const RESOLUTION = "card grid direction locked; table reserved for export view.";
const closed = await call("draft_close", { id: started.id, resolution: RESOLUTION });
check("draft_close: resolved, issue closed", closed.issueClosed === true && closed.gateTexts?.length === 1);
check("archive: session archived",
  existsSync(join(PROJECT, ".cairn", "draft", "archive", `${started.id}.md`)));

// -- wrap: CSS-pattern synthesis ----------------------------------------------
console.log("wrap mechanics: packaging the decided direction...");
const skillDir = join(PROJECT, ".claude", "skills", "dashboard-direction");
mkdirSync(join(skillDir, "references"), { recursive: true });
writeFileSync(join(skillDir, "references", "css-patterns.md"), [
  "# CSS Patterns", "", "## Design Decisions",
  "- card grid over table at dashboard density (50 items)",
  "## CSS Patterns", "```css",
  ...theme.split("\n").filter((l) => l.includes("--")), "```",
  "## What to Avoid", "- component styles or layout rules in the theme file — custom properties only",
  "## Origin", `- session: ${started.id}`, `- tracker issue: ${started.issue}`,
  `- files: .cairn/draft/${started.id}/001-cards.html, 002-table.html`, "",
].join("\n"));
const ref = readFileSync(join(skillDir, "references", "css-patterns.md"), "utf8");
check("wrap: CSS-pattern synthesis with provenance",
  ref.includes("--color-primary") && ref.includes(started.id) && ref.includes(started.issue));

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
