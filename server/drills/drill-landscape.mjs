#!/usr/bin/env node

// Purpose: Tier C2 landscape drill (mechanical) — proves the frontier-mode
//          memory per the spec: an archived stop-resolution probe appears in
//          session_landscape WITH its resolution text (the never-re-propose
//          input), phase linkage groups correctly, and two calls against an
//          unchanged store are byte-equal.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "landscape-drill", version: "0.0.0" });
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

// -- a probe that dies with a stop verdict, under a phase --------------------
console.log("staging a stop-verdict probe under phase 2...");
await call("context_set", { phase: 2 });
const dead = await call("probe_start", { description: "drill: third-party OCR for receipts" });
check("probe under active phase", Boolean(dead.id), JSON.stringify(dead.__error ?? "").slice(0, 100));
await call("probe_log", { id: dead.id, kind: "experiment", text: "ran 50 sample receipts through the OCR trial tier" });
await call("probe_log", { id: dead.id, kind: "verdict", text: "INVALIDATED — 40% field accuracy, unusable" });
const STOP = "stop — OCR accuracy is nowhere near viable; revisit only if the vendor ships their v3 model.";
await call("probe_close", { id: dead.id, resolution: STOP });

// one open draft for contrast
const open = await call("draft_start", { description: "drill: settings page layout" });

// -- landscape carries the stop memory ---------------------------------------
const scape = await call("session_landscape", {});
const stopped = scape.sessions?.find((s) => s.id === dead.id);
check("archived stop probe present, resolved", stopped?.status === "resolved");
check("resolution text carried — the never-re-propose input", stopped?.resolution === STOP);
check("phase linkage groups the probe under phase 2",
  scape.phases?.some((p) => p.phase === "2" && p.sessions.includes(dead.id)));
check("openByKind: 1 draft open, 0 probes",
  scape.openByKind?.draft >= 1 && scape.openByKind?.probe === 0);

// -- byte-equality across two calls ------------------------------------------
const again = await call("session_landscape", {});
check("two calls byte-equal on unchanged store",
  JSON.stringify(scape) === JSON.stringify(again));

// cleanup: close the open draft so the scratch repo ends tidy
await call("draft_log", { id: open.id, kind: "decision", text: "single-column settings, no tabs" });
await call("draft_close", { id: open.id, resolution: "single column locked" });

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
