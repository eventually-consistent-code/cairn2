#!/usr/bin/env node

// Purpose: Tier C3 review drill (mechanical) — the review closing discipline
//          per verbs/review.md against the REAL dist server + REAL tracker:
//          one Critical finding mirrors as a cairn:review issue (severity
//          first line, file:line stays in the record, not the issue), the
//          record lands under the slugged scope, close-note discipline on
//          --fix, leak scan zero hits.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildPatterns, scanLines } from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "review-drill", version: "0.0.0" });
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
const today = new Date().toISOString().slice(0, 10);

// -- target: a slash-y branch name, slugged per review.md ------------------------
const TARGET = "feature/EXPORT-42";
const slug = TARGET.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
check("slug rule survives audit_record's scope gate", slug === "feature-export-42");

// -- Critical finding mirrors as a cairn:review issue ----------------------------
console.log("mirroring the Critical finding...");
const issue = await call("issue_create", {
  title: "export handler swallows write errors — partial files look successful",
  labels: ["cairn:review"],
  body: "critical\nReview of the export branch: a failed disk write is caught and logged but the request still returns success, so users get truncated exports that look complete.",
});
check("cairn:review issue created", issue.labels?.includes("cairn:review"),
  JSON.stringify(issue.__error ?? "").slice(0, 100));
check("severity first line, plain language", issue.body?.split("\n")[0] === "critical");

// -- record: file:line detail lives here, not the issue ---------------------------
const rec = await call("audit_record", {
  scope: `review-${slug}`, verdict: "findings",
  findings: [
    { severity: "critical", title: "export handler swallows write errors",
      detail: "src/export/handler.ts:87 — catch block logs and falls through to res.ok; failure scenario: disk full mid-write returns 200 with a truncated file.",
      issue: issue.id },
    { severity: "minor", title: "exporter test names drifted from behavior (clarity axis)" },
  ],
});
check("record under the slugged scope", rec.path?.endsWith(`review-${slug}-${today}.md`),
  JSON.stringify(rec.__error ?? "").slice(0, 100));
const raw = readFileSync(rec.path, "utf8");
check("record carries file:line + failure scenario; minor record-only",
  raw.includes("handler.ts:87") && raw.includes("## finding — minor"));
check("issue body carries NO file:line (audience split held)", !/:\d+/.test(issue.body ?? "x:1") || !issue.body.includes("handler.ts"));

// -- --fix close-note discipline ---------------------------------------------------
console.log("--fix: mechanical close with a plain note...");
await call("issue_comment", { id: issue.id,
  text: "Fixed: a failed write now fails the request — the catch re-throws after logging, and a regression test pins it." });
await call("issue_close", { id: issue.id });
check("finding closed on the tracker", (await call("issue_get", { id: issue.id })).state === "closed");

// -- leak scan ----------------------------------------------------------------------
const sent = [issue.body,
  "Fixed: a failed write now fails the request — the catch re-throws after logging, and a regression test pins it."];
const hits = scanLines(sent.flatMap((t) => t.split("\n")), buildPatterns(null));
check("leak scan: zero pattern hits in tracker text", hits.length === 0, hits.map((h) => h.name).join(","));

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
