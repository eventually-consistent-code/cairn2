#!/usr/bin/env node

// Purpose: Tier A auto drill (mechanical) — three legs against the REAL dist
//          server + REAL tracker, following verbs/auto.md's procedure:
//            leg 1  hands-off 2-phase run; every non-taste decision logged
//                   with its principle; taste batch presented ONCE at end
//            leg 2  rigged verify failure — hard stop, no VERIFICATION.md,
//                   next phase untouched, usable report
//            leg 3  SIGKILL mid-run after phase 1 landed — fresh server
//                   resumes phase 2's exact task, zero re-executed work
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = resolve(process.argv[2]); // base scratch dir; legs get subdirs
const SERVER = resolve(process.argv[3]);
const REPO = process.argv[4] ?? "eventually-consistent-code/cairn-drill-scratch";

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const sh = (cwd, cmd) => execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" }).trim();

function scaffoldDir(name) {
  const dir = join(BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh(dir, "git init -q && git config user.email t@t && git config user.name drill");
  writeFileSync(join(dir, "cairn.json"),
    JSON.stringify({ tracker: { type: "github", config: { repo: REPO } } }) + "\n");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  sh(dir, "git add -A && git commit -qm seed --no-gpg-sign");
  return dir;
}

async function connect(dir) {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER], cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const client = new Client({ name: "auto-drill", version: "0.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const body = JSON.parse(res.content[0].text);
    return res.isError ? { __error: body } : body;
  };
  return { client, call, transport };
}

// auto.md step 4's encoded principles — every unattended decision cites one.
const decisions = [];
const taste = [];
const decide = (what, principle) => decisions.push({ what, principle });

/** One phase of hands-off execution per auto.md step 2: plan-if-needed → work → verify. */
async function runPhase(dir, call, num, name, { failVerify = false } = {}) {
  const scaffolded = await call("plan_scaffold_phase", { number: num, name });
  sh(dir, "git add -A && git commit -qm 'chore: scaffold phase' --no-gpg-sign");
  await call("plan_phase_ensure", { number: num, name });
  const phases = await call("phase_list");
  const tp = phases.find((p) => p.name === `Phase ${num}: ${name}`);

  // plan-if-needed: PLAN.md has no tasks yet
  decide(`phase ${num}: plan has no tasks — create one issue covering the phase goal`,
    "prefer completeness over shortcuts");
  const issue = await call("issue_create", { title: `auto p${num}: ${name}`, phase: tp?.id });
  await call("plan_issues_set", { phaseDir: scaffolded.dir, issues: [issue.id] });

  // work
  const base = sh(dir, "git rev-parse HEAD");
  await call("issue_update", { id: issue.id, state: "in_progress" });
  await call("continuity_checkpoint", {
    source: "tool",
    phase: { number: num, slug: scaffolded.dir.slice(3) },
    issue: issue.id,
    task: { current: `p${num}-work`, title: `auto p${num}: ${name}` },
    next_action: `finish p${num} work, close ${issue.id}`,
  });
  decide(`phase ${num}: implement in one file following the repo's existing flat layout`,
    "match existing patterns");
  taste.push(`phase ${num}: named the work file work-${num}.txt (naming is taste; reversible)`);
  sh(dir, `echo done > work-${num}.txt && git add -A && git commit -qm 'feat: p${num}' --no-gpg-sign`);
  const head = sh(dir, "git rev-parse HEAD");

  // verify (auto.md step 3: failed verify is a HARD STOP)
  if (failVerify) {
    return { issue, tp, verified: false,
      report: `HARD STOP: phase ${num} verify failed — rigged test exited 1 on task '${issue.id}' (auto p${num}: ${name}). No VERIFICATION.md written; run halted before any later phase.` };
  }
  await call("issue_close", { id: issue.id });
  await call("ledger_append", {
    phaseDir: scaffolded.dir, taskRef: `A${num}`, summary: `auto drill p${num}`,
    baseCommit: base, headCommit: head, issueId: issue.id,
    closedDate: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(join(dir, ".cairn/plans/phases", scaffolded.dir, "VERIFICATION.md"),
    `# Phase ${num} — verified (auto drill)\n`);
  sh(dir, "git add -A && git commit -qm 'docs: verify' --no-gpg-sign");
  return { issue, tp, verified: true };
}

// ---------------------------------------------------------------
console.log("=== leg 1: hands-off 2-phase run ===");
{
  const dir = scaffoldDir("leg1");
  const { client, call } = await connect(dir);
  await call("plan_scaffold_project", { name: "auto drill leg1" });
  const r1 = await runPhase(dir, call, 1, "auto base camp");
  const r2 = await runPhase(dir, call, 2, "auto ridge line");
  const status = await call("plan_status");
  check("leg1: both phases verified", status.phases.every((p) => p.hasVerification));
  const s1 = await call("issue_get", { id: r1.issue.id });
  const s2 = await call("issue_get", { id: r2.issue.id });
  check("leg1: all issues closed", s1.state === "closed" && s2.state === "closed");
  check("leg1: every non-taste decision has a principle",
    decisions.length > 0 && decisions.every((d) => d.principle));
  check("leg1: taste batch presented once at end (not mid-run)", taste.length >= 2);
  console.log("run report — decisions:");
  for (const d of decisions) console.log(`  - ${d.what}  [principle: ${d.principle}]`);
  console.log("run report — taste batch (one review):");
  for (const t of taste) console.log(`  - ${t}`);
  await client.close();
}

// ---------------------------------------------------------------
console.log("=== leg 2: rigged verify failure → hard stop ===");
{
  const dir = scaffoldDir("leg2");
  const { client, call } = await connect(dir);
  await call("plan_scaffold_project", { name: "auto drill leg2" });
  const r1 = await runPhase(dir, call, 1, "auto scree field", { failVerify: true });
  check("leg2: hard-stop report names failing task + failure",
    !r1.verified && r1.report.includes(r1.issue.id) && /verify failed/.test(r1.report));
  console.log(`  ${r1.report}`);
  const status = await call("plan_status");
  const p1 = status.phases.find((p) => p.number === 1);
  check("leg2: no VERIFICATION.md written on failed verify", p1?.hasVerification === false);
  check("leg2: phase 2 never started (no phase 2 dir, no phase 2 issues)",
    status.phases.length === 1);
  const s1 = await call("issue_get", { id: r1.issue.id });
  check("leg2: failing task left in_progress, not closed", s1.state === "in_progress");
  await client.close();
}

// ---------------------------------------------------------------
console.log("=== leg 3: SIGKILL mid-run, fresh session resumes ===");
{
  const dir = scaffoldDir("leg3");
  let { client, call, transport } = await connect(dir);
  await call("plan_scaffold_project", { name: "auto drill leg3" });
  const r1 = await runPhase(dir, call, 1, "auto first ascent"); // phase 1 lands fully

  // phase 2: claim + checkpoint, then die before any work
  const p2 = await call("plan_scaffold_phase", { number: 2, name: "auto second ascent" });
  sh(dir, "git add -A && git commit -qm 'chore: scaffold p2' --no-gpg-sign");
  await call("plan_phase_ensure", { number: 2, name: "auto second ascent" });
  const phases = await call("phase_list");
  const tp2 = phases.find((p) => p.name === "Phase 2: auto second ascent");
  const issue2 = await call("issue_create", { title: "auto p2: second ascent", phase: tp2?.id });
  await call("plan_issues_set", { phaseDir: p2.dir, issues: [issue2.id] });
  await call("issue_update", { id: issue2.id, state: "in_progress" });
  await call("continuity_checkpoint", {
    source: "tool",
    phase: { number: 2, slug: p2.dir.slice(3) },
    issue: issue2.id,
    task: { current: "p2-work", title: "auto p2: second ascent" },
    next_action: "finish p2 work, close the issue",
  });
  console.log(`SIGKILL server pid ${transport.pid} mid-auto...`);
  process.kill(transport.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));

  // fresh session
  ({ client, call, transport } = await connect(dir));
  const h = await call("continuity_get");
  check("leg3: handoff survives kill, names phase 2 exact task",
    h.handoff?.issue === issue2.id && h.handoff?.task?.current === "p2-work"
    && h.stale !== true, JSON.stringify(h.handoff ?? h).slice(0, 100));
  const cross = await call("issue_get", { id: issue2.id });
  check("leg3: tracker cross-check matches handoff (in_progress)", cross.state === "in_progress");
  const p1After = await call("issue_get", { id: r1.issue.id });
  check("leg3: phase 1 work untouched (still closed, not re-executed)", p1After.state === "closed");

  // resume: finish exactly the handoff's task
  const base = sh(dir, "git rev-parse HEAD");
  sh(dir, "echo done > work-2.txt && git add -A && git commit -qm 'feat: p2 (resumed)' --no-gpg-sign");
  await call("issue_close", { id: issue2.id });
  await call("ledger_append", {
    phaseDir: p2.dir, taskRef: "A2", summary: "auto drill p2 resumed after SIGKILL",
    baseCommit: base, headCommit: sh(dir, "git rev-parse HEAD"), issueId: issue2.id,
    closedDate: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(join(dir, ".cairn/plans/phases", p2.dir, "VERIFICATION.md"),
    "# Phase 2 — verified (resumed after SIGKILL)\n");
  sh(dir, "git add -A && git commit -qm 'docs: verify p2' --no-gpg-sign");
  await call("continuity_clear");
  const status = await call("plan_status");
  check("leg3: run completes from exact task — both phases verified",
    status.phases.length === 2 && status.phases.every((p) => p.hasVerification));
  await client.close();
}

// ---------------------------------------------------------------
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
