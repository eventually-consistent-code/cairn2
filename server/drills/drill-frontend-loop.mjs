#!/usr/bin/env node

// Purpose: Tier F3 frontend-loop drill (mechanical) — the #2290 data rails
//          the designer/uat agents run on, per spec §5: a draft session
//          decides a direction with tokens.json + default.css in sync; map
//          edges record requirement→decision→module traceability (with the
//          read-unfiltered-append-write discipline); the traceability sweep
//          names exactly the seeded gap; a fidelity divergence lands as a
//          real cairn:audit issue citing the decision entry; tokens/CSS
//          drift is detectable; leak scan clean.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  buildPatterns,
  scanLines,
} from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "frontend-loop-drill", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

// -- two requirements on the tracker; only one will be designed ---------------
console.log("staging requirements...");
const reqTraced = await call("issue_create", {
  title: "dashboard shows live export progress",
  labels: ["cairn:backlog"],
  body: "Users need to see export progress without refreshing.",
});
const reqUntraced = await call("issue_create", {
  title: "settings page gets a dark mode toggle",
  labels: ["cairn:backlog"],
  body: "Dark mode is table stakes; users keep asking.",
});

// -- designer rails: draft session, tokens in sync, decision entry -------------
console.log("designer rails: session + tokens + decision...");
const session = await call("draft_start", {
  description: "drill: export progress surface",
});
await call("issue_comment", {
  id: session.issue,
  text: "Sketching the export progress surface — wireframes first, then tokens, then a coded prototype.",
});

const themesDir = join(PROJECT, ".cairn", "draft", "themes");
mkdirSync(themesDir, { recursive: true });
const CSS =
  ":root {\n  --color-primary: #2563eb;\n  --color-bg: #fafafa;\n  --space-2: 0.5rem;\n}\n";
writeFileSync(join(themesDir, "default.css"), CSS);
writeFileSync(
  join(themesDir, "tokens.json"),
  JSON.stringify(
    {
      color: { primary: "#2563eb", bg: "#fafafa" },
      space: { 2: "0.5rem" },
    },
    null,
    2,
  ) + "\n",
);

const cssProps = [...CSS.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).sort();
const tokens = JSON.parse(readFileSync(join(themesDir, "tokens.json"), "utf8"));
const tokenProps = Object.entries(tokens)
  .flatMap(([g, o]) => Object.keys(o).map((k) => `${g}-${k}`))
  .sort();
check(
  "tokens.json ↔ default.css in sync",
  JSON.stringify(cssProps) === JSON.stringify(tokenProps),
  `${cssProps} vs ${tokenProps}`,
);

await call("draft_log", {
  id: session.id,
  kind: "variant",
  text: "001-progress-bar.html — inline bar under the export button",
});
const DECISION =
  "inline progress bar under the export button; polling every 2s per the probe's rate findings";
await call("draft_log", { id: session.id, kind: "decision", text: DECISION });
await call("issue_comment", {
  id: session.issue,
  text: "Decision: inline progress bar under the export button. Tokens locked; prototype next.",
});

// -- traceability edges: surgical edgesAdd, no wholesale replace ---------------
// (wholesale `edges` went rebuild-only in #71 — edgesAdd is the everyday op,
// and it retired the old read-append-write dance entirely.)
console.log("traceability: both edges via edgesAdd...");
await call("map_set", {
  patch: {
    nodes: {
      [reqTraced.id]: {
        type: "issue",
        label: "dashboard shows live export progress",
      },
      "dec-progress-bar": { type: "decision", label: DECISION },
      "mod-dashboard": { type: "module", label: "dashboard" },
    },
  },
});
await call("map_set", {
  patch: {
    edgesAdd: [
      { from: reqTraced.id, to: "dec-progress-bar", type: "implements" },
      { from: "dec-progress-bar", to: "mod-dashboard", type: "decided-in" },
    ],
  },
});
const withEdges = await call("map_get", {});
check(
  "both traceability edges recorded",
  withEdges.edges.length === 2 &&
    withEdges.edges.some((e) => e.type === "implements") &&
    withEdges.edges.some((e) => e.type === "decided-in"),
);

// -- the sweep: one traced, one seeded gap ----------------------------------------
console.log("uat rails: traceability sweep...");
const scape = await call("map_get", {});
const gaps = [];
for (const req of [reqTraced, reqUntraced]) {
  const hasImplements = scape.edges.some(
    (e) => e.from === req.id && e.type === "implements",
  );
  if (!hasImplements) gaps.push(req);
}
check(
  "sweep names exactly the seeded gap",
  gaps.length === 1 && gaps[0].id === reqUntraced.id,
);
const rec = await call("audit_record", {
  scope: "uat-frontend-drill",
  verdict: "findings",
  findings: [
    {
      severity: "important",
      title: "requirement has no decided design — dark mode toggle untraced",
      detail:
        "no implements edge from the requirement issue; the designer never saw it",
      issue: reqUntraced.id,
    },
  ],
});
check("gap recorded as an important finding", rec.findings === 1);

// -- fidelity: divergence cites the decision entry ---------------------------------
console.log("fidelity: divergence lands citing the decision...");
const FIDELITY_BODY =
  'important\nShipped dashboard uses a modal progress dialog — the draft session decided an INLINE bar under the export button. Violates the decision entry: "' +
  DECISION +
  '"';
const fidelity = await call("issue_create", {
  title: "shipped progress UI diverges from the decided direction",
  labels: ["cairn:audit"],
  body: FIDELITY_BODY,
});
check(
  "fidelity finding cites the decision entry",
  fidelity.labels?.includes("cairn:audit") &&
    fidelity.body.includes("INLINE bar"),
);

// -- drift detection: seed tokens/CSS divergence ------------------------------------
console.log("drift: seeded token divergence detected...");
writeFileSync(
  join(themesDir, "tokens.json"),
  JSON.stringify(
    {
      color: { primary: "#2563eb", bg: "#fafafa", danger: "#ef4444" },
      space: { 2: "0.5rem" },
    },
    null,
    2,
  ) + "\n",
);
const tokens2 = JSON.parse(
  readFileSync(join(themesDir, "tokens.json"), "utf8"),
);
const tokenProps2 = Object.entries(tokens2)
  .flatMap(([g, o]) => Object.keys(o).map((k) => `${g}-${k}`))
  .sort();
check(
  "drift detected (token without a CSS twin)",
  JSON.stringify(cssProps) !== JSON.stringify(tokenProps2) &&
    tokenProps2.includes("color-danger") &&
    !cssProps.includes("color-danger"),
);

// -- close out + leak scan -----------------------------------------------------------
await call("draft_close", {
  id: session.id,
  resolution: "inline progress bar locked; prototype in the session artifacts",
});
await call("issue_comment", {
  id: fidelity.id,
  text: "Fixed: dashboard back to the inline bar per the decided direction; modal removed.",
});
await call("issue_close", { id: fidelity.id });
for (const r of [reqTraced, reqUntraced])
  await call("issue_close", { id: r.id });
const sent = [FIDELITY_BODY.split("\n")[1]];
const hits = scanLines(sent, buildPatterns(null));
check("leak scan: zero hits on tracker text", hits.length === 0);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
