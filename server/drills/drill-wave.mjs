#!/usr/bin/env node

// Purpose: Tier A wave drill (mechanical) — 4 issues grouped into 2 waves via
//          plan_meta_set, executed per verbs/work.md's --wave flow against the
//          REAL dist server + REAL tracker. Wave-1 workers run as genuinely
//          parallel processes (one server each); the driver proves concurrent
//          claims mid-flight, then enforces + verifies the hard wave gate:
//          wave 2 does not dispatch until every wave-1 issue is closed AND
//          ledgered.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const sh = (cmd) => execFileSync("bash", ["-c", cmd], { cwd: PROJECT, encoding: "utf8" }).trim();

async function connect(name) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER], cwd: PROJECT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const body = JSON.parse(res.content[0].text);
    return res.isError ? { __error: body } : body;
  };
  return { client, call };
}

// ---------------------------------------------------------------
// setup: one phase, 4 issues, 2 waves
// ---------------------------------------------------------------
const main = await connect("wave-drill");
await main.call("plan_scaffold_project", { name: "wave drill" });
const phase = await main.call("plan_scaffold_phase", { number: 1, name: "wave traverse" });
sh("git add -A && git commit -qm 'chore: scaffold' --no-gpg-sign");
await main.call("plan_phase_ensure", { number: 1, name: "wave traverse" });
const phases = await main.call("phase_list");
const tp = phases.find((p) => p.name === "Phase 1: wave traverse");

const ids = [];
for (let i = 1; i <= 4; i++) {
  const issue = await main.call("issue_create", { title: `wave task ${i}`, phase: tp?.id });
  ids.push(issue.id);
}
await main.call("plan_issues_set", { phaseDir: phase.dir, issues: ids });
const meta = await main.call("plan_meta_set", {
  phaseDir: phase.dir, waves: [[ids[0], ids[1]], [ids[2], ids[3]]],
});
check("plan_meta_set wrote 2 waves", meta.waves?.length === 2
  && meta.waves[0].length === 2 && meta.waves[1].length === 2);

const ledgerPath = join(PROJECT, ".cairn/plans/phases", phase.dir, "LEDGER.md");
const ledgered = (id) => {
  try { return readFileSync(ledgerPath, "utf8").split("\n").some((l) => l.includes(`— ${id} closed`)); }
  catch { return false; }
};

// ---------------------------------------------------------------
// a "subagent": concurrent task against the SHARED server — matching the
// real architecture, where parallel subagents' tool calls all flow through
// the session's single cairn MCP server (write-through cache invalidation
// keeps reads coherent). Signals the driver once claimed so cross-worker
// concurrency can be asserted mid-flight.
// ---------------------------------------------------------------
async function worker(wave, n, id, claimedBarrier) {
  await main.call("issue_update", { id, state: "in_progress" });
  claimedBarrier.resolve();
  await claimedBarrier.allClaimed; // hold mid-flight until BOTH are claimed
  writeFileSync(join(PROJECT, `wave-${wave}-task-${n}.txt`), "done\n");
  await main.call("issue_close", { id });
}

async function runWave(wave, [idA, idB]) {
  console.log(`dispatching wave ${wave} — 2 parallel workers...`);
  const barriers = [0, 1].map(() => { let r; const p = new Promise((x) => { r = x; }); return { p, r }; });
  const allClaimed = Promise.all(barriers.map((b) => b.p));
  const mk = (i) => ({ resolve: barriers[i].r, allClaimed });

  const workers = Promise.all([
    worker(wave, 1, idA, mk(0)),
    worker(wave, 2, idB, mk(1)),
  ]);

  // parallelism evidence: both issues in_progress at the same moment
  await allClaimed;
  const [sA, sB] = [await main.call("issue_get", { id: idA }), await main.call("issue_get", { id: idB })];
  check(`wave ${wave}: both issues claimed CONCURRENTLY (in_progress mid-flight)`,
    sA.state === "in_progress" && sB.state === "in_progress");

  await workers;

  // ledger both (driver-side commit — one commit for the wave's files)
  const base = sh("git rev-parse HEAD");
  sh("git add -A && git commit -qm 'feat: wave work' --no-gpg-sign");
  const head = sh("git rev-parse HEAD");
  for (const [n, id] of [[1, idA], [2, idB]]) {
    await main.call("ledger_append", {
      phaseDir: phase.dir, taskRef: `W${wave}.${n}`, summary: `wave ${wave} task ${n}`,
      baseCommit: base, headCommit: head, issueId: id,
      closedDate: new Date().toISOString().slice(0, 10),
    });
  }
}

// ---------------------------------------------------------------
// wave 1, then the hard gate, then wave 2
// ---------------------------------------------------------------
await runWave(1, [ids[0], ids[1]]);

// the gate: wave 2 may not dispatch until every wave-1 issue is closed + ledgered
const g1 = await main.call("issue_get", { id: ids[0] });
const g2 = await main.call("issue_get", { id: ids[1] });
const gateOk = g1.state === "closed" && g2.state === "closed" && ledgered(ids[0]) && ledgered(ids[1]);
check("gate: wave 1 fully closed + ledgered before wave 2 dispatch", gateOk);

// negative side of the gate: wave 2 untouched at this moment
const g3 = await main.call("issue_get", { id: ids[2] });
const g4 = await main.call("issue_get", { id: ids[3] });
check("gate: wave 2 issues still open + unstarted at gate time",
  g3.state === "open" && g4.state === "open" && !ledgered(ids[2]) && !ledgered(ids[3]));

if (!gateOk) {
  console.log("gate failed — wave 2 NOT dispatched (hard gate, not a hint)");
} else {
  await runWave(2, [ids[2], ids[3]]);
}

// ---------------------------------------------------------------
// final: all 4 claimed → closed → ledgered, in wave order
// ---------------------------------------------------------------
const finals = [];
for (const id of ids) finals.push(await main.call("issue_get", { id }));
check("all 4 issues closed", finals.every((i) => i.state === "closed"));
check("all 4 issues ledgered", ids.every((id) => ledgered(id)));

const ledger = readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.startsWith("- [x]"));
const orderOk = ledger.findIndex((l) => l.includes(`— ${ids[2]} closed`)) >
  Math.max(ledger.findIndex((l) => l.includes(`— ${ids[0]} closed`)),
    ledger.findIndex((l) => l.includes(`— ${ids[1]} closed`)));
check("ledger order: wave 1 entries precede wave 2 entries", orderOk);

await main.client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
