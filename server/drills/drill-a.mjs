#!/usr/bin/env node

// Purpose: Tier A0 kill drill (mechanical) — Drill A phase 1.
//          Drive the REAL dist server over stdio against a REAL GitHub
//          tracker, get mid-work state into the handoff, then SIGKILL the
//          server process and prove the handoff survived intact.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";

const PROJECT = process.argv[2];
const SERVER = process.argv[3];

const hash = createHash("sha256").update(resolve(PROJECT)).digest("hex").slice(0, 16);
const HANDOFF = join(homedir(), ".cairn", "handoff", `${basename(PROJECT)}-${hash}.json`);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "kill-drill", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

console.log("creating issue on real tracker...");
const issue = await call("issue_create", { title: "drill-a: mid-work task" });
console.log(`issue ${issue.id} created`);

console.log("starting work (issue_update in_progress)...");
await call("issue_update", { id: issue.id, state: "in_progress" });

console.log("checkpointing task detail...");
await call("continuity_checkpoint", {
  source: "tool",
  task: { current: "step-2", title: "write the thing" },
  next_action: "finish step-2 then close the issue",
});

// hard kill mid-session -- this is the drill
const pid = transport.pid;
console.log(`SIGKILL server pid ${pid}...`);
process.kill(pid, "SIGKILL");
await new Promise((r) => setTimeout(r, 300));

// handoff must have survived the kill, valid JSON, naming the exact task
const h = JSON.parse(readFileSync(HANDOFF, "utf8"));
const checks = [
  ["handoff file valid JSON after SIGKILL", true],
  ["issue survives", h.issue === issue.id],
  ["task.current survives", h.task?.current === "step-2"],
  ["next_action survives", h.next_action === "finish step-2 then close the issue"],
  ["version 1", h.version === 1],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
console.log(`ISSUE_ID=${issue.id}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
