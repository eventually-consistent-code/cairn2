#!/usr/bin/env node

// Purpose: Tier F1 focus-compat drill (mechanical) — the single-project
//          compatibility guarantee: with NO workspace anywhere,
//          workspace_list reports null and every stateful surface lands
//          exactly where it did pre-F1 (launch-dir .cairn paths, session
//          files, audit records, map store) with the workspace layer
//          invisible.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const PROJECT = resolve(process.argv[2]);   // fresh scratch dir, cairn.json only
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "focus-compat-drill", version: "0.0.0" });
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

// -- workspace layer invisible ---------------------------------------------------
console.log("no workspace: layer reports null, focus refuses...");
const ws = await call("workspace_list", {});
check("workspace_list: null workspace, not an error", ws.workspace === null && !ws.__error);
const focus = await call("workspace_focus", { project: "anything" });
check("workspace_focus without a workspace refused", Boolean(focus.__error));
const board = await call("board_get", {});
check("board_get without a workspace refused with the init hint",
  Boolean(board.__error) && JSON.stringify(board.__error).includes("basecamp init"));

// -- stateful surfaces land at the launch dir, pre-F1 paths ----------------------
console.log("stateful surfaces: pre-F1 paths exactly...");
await call("context_set", { phase: 2 });
check("active context under launch-dir .cairn", existsSync(join(PROJECT, ".cairn")));

const probe = await call("probe_start", { description: "compat: does anything move?" });
check("session file at launch-dir path",
  existsSync(join(PROJECT, ".cairn", "probe", `${probe.id}.md`)),
  JSON.stringify(probe.__error ?? "").slice(0, 80));
check("session phase stamped from launch-dir context",
  (await call("session_landscape", {})).sessions.find((s) => s.id === probe.id)?.phase === "2");

const rec = await call("audit_record", { scope: "compat", verdict: "pass", findings: [] });
check("audit record at launch-dir path", rec.path === join(PROJECT, ".cairn", "audit",
  `compat-${new Date().toISOString().slice(0, 10)}.md`));

await call("map_set", { patch: { nodes: { "m1": { type: "module", label: "compat" } } } });
check("map store at launch-dir path", existsSync(join(PROJECT, ".cairn", "map", "map.json")));

// close out the probe so the store ends tidy
await call("probe_log", { id: probe.id, kind: "verdict", text: "VALIDATED — nothing moved" });
await call("probe_close", { id: probe.id, resolution: "proceed — compat holds" });

// no .cairn/basecamp ever appeared
check("no basecamp state materialized", !existsSync(join(PROJECT, ".cairn", "basecamp")));

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
