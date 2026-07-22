#!/usr/bin/env node

// Purpose: Tier C3 plan-check drill (mechanical) — #2891 legs against the
//          REAL dist server: a seeded phase pair with one drifted
//          producer/consumer contract and one unanchored threshold yields
//          exactly two findings with correct lines and counterpart; adding
//          the shared fixture + anchor silences both; two calls byte-equal.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "plan-check-drill", version: "0.0.0" });
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

const plan = (phaseDir, body) => {
  const base = join(PROJECT, ".cairn", "plans", "phases", phaseDir);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "PLAN.md"), body);
};

// -- seeded drift + unanchored threshold --------------------------------------
console.log("seeding a drifted contract pair and a bare threshold...");
plan("01-export", [
  "# Phase 1 — export",
  "",
  "- Produces: `exportRows(filter: Filter): Stream` — streaming, no buffering",
  "",
].join("\n"));
plan("02-dashboard", [
  "# Phase 2 — dashboard",
  "",
  "- Consumes: `exportRows(filter: Filter, limit: number): Stream`",
  "",
  "Dashboard first paint must be < 100ms.",
  "",
].join("\n"));

const dirty = await call("plan_check", {});
check("two findings exactly", dirty.findings?.length === 2,
  JSON.stringify(dirty.__error ?? dirty.findings ?? "").slice(0, 120));
const drift = dirty.findings?.find((f) => f.type === "contract-drift");
const thresh = dirty.findings?.find((f) => f.type === "unanchored-threshold");
check("drift: finding on the consumer, counterpart names the producer",
  drift?.plan?.includes("02-dashboard") && drift?.counterpart?.plan?.includes("01-export"));
check("drift: consumer line correct (line 3)", drift?.line === 3);
check("threshold: flagged with the matched text (line 5)",
  thresh?.line === 5 && thresh?.detail?.includes("< 100ms"));
check("scanned both plans", dirty.scanned === 2);

// -- byte-equality -------------------------------------------------------------
const again = await call("plan_check", {});
check("two calls byte-equal on unchanged tree",
  JSON.stringify(dirty) === JSON.stringify(again));

// -- fixture + anchor silence both ----------------------------------------------
console.log("fixing: shared fixture + anchored threshold...");
plan("01-export", [
  "# Phase 1 — export",
  "",
  "- Produces: `exportRows(filter: Filter): Stream` — streaming, no buffering",
  "  contract pinned in test/fixtures/export-contract.json",
  "",
].join("\n"));
plan("02-dashboard", [
  "# Phase 2 — dashboard",
  "",
  "- Consumes: `exportRows(filter: Filter, limit: number): Stream`",
  "  contract pinned in test/fixtures/export-contract.json",
  "",
  "Dashboard first paint must be < 100ms per benchmark in perf/baseline.json.",
  "",
].join("\n"));

const clean = await call("plan_check", {});
check("fixture + anchor: zero findings", clean.findings?.length === 0,
  JSON.stringify(clean.findings ?? "").slice(0, 120));

// -- phase filter ---------------------------------------------------------------
const one = await call("plan_check", { phase: 1 });
check("phase filter narrows the scan", one.scanned === 1);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
