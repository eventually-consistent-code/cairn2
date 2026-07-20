#!/usr/bin/env node

// Purpose: Tier A summit drill (mechanical) — drive the REAL dist server over
//          stdio against a REAL tracker through the full 2-phase lifecycle
//          (plan → work → verify), then the summit flow per verbs/summit.md:
//          bootstrap-offer (native backends), milestone_complete, archive +
//          tag checks, and the PRECONDITION_FAILED re-run pass condition.
//          Backend read from the project's cairn.json — expectations adjust
//          for native (jira) vs fallback (github) automatically.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const cfg = JSON.parse(readFileSync(join(PROJECT, "cairn.json"), "utf8"));
const NATIVE = cfg.tracker.type === "jira";

const git = (...args) => execFileSync("git", args, { cwd: PROJECT, encoding: "utf8" }).trim();

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "summit-drill", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  if (res.isError) return { __error: body };
  return body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------
// lifecycle: 2 phases planned, worked, verified
// ---------------------------------------------------------------
console.log(`backend: ${cfg.tracker.type} (${NATIVE ? "native milestones" : "fallback"})`);
console.log("scaffolding project + phases...");
await call("plan_scaffold_project", { name: "summit drill" });
const p1 = await call("plan_scaffold_phase", { number: 1, name: "trail head" });
const p2 = await call("plan_scaffold_phase", { number: 2, name: "switchback" });
git("add", "-A"); git("commit", "-m", "chore: scaffold", "--no-gpg-sign");

await call("plan_phase_ensure", { number: 1, name: "trail head" });
await call("plan_phase_ensure", { number: 2, name: "switchback" });

const phases = await call("phase_list");
const tp1 = phases.find((p) => p.name.startsWith("Phase 1:"));
const tp2 = phases.find((p) => p.name.startsWith("Phase 2:"));
check("tracker phase objects created", Boolean(tp1 && tp2));

for (const [num, dir, tp] of [[1, p1.dir, tp1], [2, p2.dir, tp2]]) {
  console.log(`working phase ${num}...`);
  const issue = await call("issue_create", { title: `drill task p${num}`, phase: tp.id });
  await call("plan_issues_set", { phaseDir: dir, issues: [issue.id] });
  const base = git("rev-parse", "HEAD");
  await call("issue_update", { id: issue.id, state: "in_progress" });
  execFileSync("bash", ["-c", `echo done-${num} > work-${num}.txt`], { cwd: PROJECT });
  git("add", "-A"); git("commit", "-m", `feat: phase ${num} work`, "--no-gpg-sign");
  const head = git("rev-parse", "HEAD");
  await call("issue_close", { id: issue.id });
  await call("ledger_append", {
    phaseDir: dir, taskRef: `T${num}`, summary: `phase ${num} drill work`,
    baseCommit: base, headCommit: head, issueId: issue.id,
    closedDate: new Date().toISOString().slice(0, 10),
  });
  execFileSync("bash", ["-c", `printf '# Phase ${num} — verified\\n' > .cairn/plans/phases/${dir}/VERIFICATION.md`], { cwd: PROJECT });
  git("add", "-A"); git("commit", "-m", `docs: verify phase ${num}`, "--no-gpg-sign");
}

// ---------------------------------------------------------------
// summit.md step 1: what's completing + first-milestone bootstrap
// ---------------------------------------------------------------
console.log("summit step 1: milestone_list...");
const ml = await call("milestone_list");
check("milestone_list current=1, nothing stamped", ml.current === 1 && !ml.currentId);

if (NATIVE) {
  check("native list present (hasMilestones)", Array.isArray(ml.native));
  console.log("bootstrap offer accepted: milestone_create v1...");
  const created = await call("milestone_create", { name: "v1" });
  check("native milestone created + stamped", Boolean(created.native?.id));
} else {
  check("no native list on fallback backend", ml.native === undefined);
  console.log("fallback: no bootstrap offer (hasMilestones false) — correct per summit.md step 1");
}

// ---------------------------------------------------------------
// summit.md step 3: milestone_complete
// ---------------------------------------------------------------
console.log("milestone_complete...");
const report = await call("milestone_complete", { summary: "summit drill: both phases shipped" });
check("no tool error", !report.__error, JSON.stringify(report.__error ?? "").slice(0, 120));
check("2 tracker phases closed", report.closedPhases?.length === 2);
check("no skipped phase closes", (report.skippedPhases?.length ?? 0) === 0,
  JSON.stringify(report.skippedPhases ?? []));
if (NATIVE) {
  check("native milestone released", report.released?.state === "released");
} else {
  check("native release skipped (recorded, not errored)", report.released === undefined);
}
check("nextMilestone bumped to 2", report.nextMilestone === 2);

// FS + roadmap
check("phases/ archived", !existsSync(join(PROJECT, ".cairn/plans/phases", p1.dir))
  && existsSync(join(PROJECT, ".cairn/plans/milestones/v1", p1.dir, "PLAN.md")));
const roadmap = readFileSync(join(PROJECT, ".cairn/plans/roadmap.md"), "utf8");
check("roadmap milestone: 2 + archive note", /milestone: 2/.test(roadmap)
  && roadmap.includes("summit drill: both phases shipped"));

// tracker really closed
const after = await call("phase_list");
const closedNow = [tp1.id, tp2.id].every(
  (id) => after.find((p) => p.id === id)?.state === "closed");
check("tracker phase objects read back closed", closedNow);

// summit.md step 4: agent-side git commit + tag
git("add", "-A"); git("commit", "-m", "chore(cairn): summit — v1 archived", "--no-gpg-sign");
git("tag", "v1");
check("git tag v1", git("tag", "-l", "v1") === "v1");

// summit.md step 5
await call("continuity_clear");

// ---------------------------------------------------------------
// drill step 3: immediate re-run → PRECONDITION_FAILED pass condition
// ---------------------------------------------------------------
console.log("re-running milestone_complete (post-success)...");
const rerun = await call("milestone_complete", { summary: "should not run" });
check("re-run PRECONDITION_FAILED (no live phases)",
  rerun.__error?.code === "PRECONDITION_FAILED"
  && /no live phases/.test(rerun.__error?.message ?? ""),
  JSON.stringify(rerun.__error ?? rerun).slice(0, 120));

// ---------------------------------------------------------------
await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
