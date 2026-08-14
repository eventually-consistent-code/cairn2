#!/usr/bin/env node

// Purpose: Tier B retro drill (mechanical) — verbs/retro.md's flow against a
//          REAL completed phase on a REAL tracker: work a phase to verified
//          (issue claimed/closed/ledgered with real commits), PLANT a wrong
//          prior card at confidence high, then run the retro steps: gather
//          evidence, write a provenance-backed lesson, re-grade the planted
//          card DOWN via mem_card_update, write the correction as a NEW card.
//          Pass = spec success criterion 3: a card's confidence changed
//          because of what the phase proved.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const git = (...args) =>
  execFileSync("git", args, { cwd: PROJECT, encoding: "utf8" }).trim();

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "retro-drill", version: "0.0.0" });
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

// -- setup: one phase worked to verified on the real tracker -----------------
console.log("working phase 1 to verified on the real tracker...");
await call("plan_scaffold_project", { name: "retro drill" });
const phase = await call("plan_scaffold_phase", {
  number: 1,
  name: "retry logic",
});
git("add", "-A");
git("commit", "-m", "chore: scaffold", "--no-gpg-sign");
await call("plan_phase_ensure", { number: 1, name: "retry logic" });
const issue = await call("issue_create", {
  title: "retro drill: harden retries",
});
await call("plan_issues_set", { phaseDir: phase.dir, issues: [issue.id] });
const base = git("rev-parse", "HEAD");
await call("issue_update", { id: issue.id, state: "in_progress" });
writeFileSync(
  join(PROJECT, "retry.ts"),
  "// deadline-based retry: count-based retries masked the real failure mode\nexport const RETRY_DEADLINE_MS = 30_000;\n",
);
git("add", "-A");
git("commit", "-m", "feat: deadline-based retry", "--no-gpg-sign");
const head = git("rev-parse", "HEAD");
await call("issue_close", { id: issue.id });
await call("ledger_append", {
  phaseDir: phase.dir,
  taskRef: "R1",
  summary: "deadline-based retry landed",
  baseCommit: base,
  headCommit: head,
  issueId: issue.id,
  closedDate: new Date().toISOString().slice(0, 10),
});
writeFileSync(
  join(PROJECT, ".cairn/plans/phases", phase.dir, "VERIFICATION.md"),
  "# Phase 1 — verified\n",
);
git("add", "-A");
git("commit", "-m", "docs: verify phase 1", "--no-gpg-sign");

// -- plant the WRONG prior card at high confidence ----------------------------
const planted = await call("mem_card_create", {
  type: "gotcha",
  body: "retries fail because of network flakiness — bump the retry COUNT when tests flake",
  scopePhase: 1,
  confidence: "high",
  provenance: [{ file: "retry.ts", commit: head }],
});
check(
  "planted wrong prior card at high",
  planted.frontmatter?.confidence === "high",
);

// -- retro step 1: gather evidence -------------------------------------------
const ledger = readFileSync(
  join(PROJECT, ".cairn/plans/phases", phase.dir, "LEDGER.md"),
  "utf8",
);
const closed = await call("issue_get", { id: issue.id });
check(
  "evidence gathered: ledger line + closed issue",
  ledger.includes(issue.id) && closed.state === "closed",
);

// -- retro step 2: lesson with provenance + confidence ------------------------
const lesson = await call("mem_card_create", {
  type: "decision",
  body: "retry hardening: use a DEADLINE, not a count — the phase's failures were time-budget exhaustion, not transient network (proven by the deadline fix closing the issue)",
  scopePhase: 1,
  confidence: "high",
  provenance: [{ file: "retry.ts", commit: head }],
});
check(
  "lesson card written with provenance + high confidence",
  lesson.frontmatter?.confidence === "high" &&
    lesson.frontmatter?.provenanceFiles?.includes("retry.ts"),
);

// -- retro step 3: re-grade the contradicted planted card DOWN ----------------
const regraded = await call("mem_card_update", {
  id: planted.id,
  confidence: "low",
});
check(
  "planted card re-graded high → low via mem_card_update",
  regraded.frontmatter?.confidence === "low" && regraded.id === planted.id,
);
const correction = await call("mem_card_create", {
  type: "gotcha",
  body: "superseded: 'bump retry count' was wrong — count-based retries masked time-budget exhaustion; see the deadline decision card",
  scopePhase: 1,
  confidence: "high",
  provenance: [{ file: "retry.ts", commit: head }],
});
check(
  "correction written as NEW card (bodies immutable)",
  correction.id !== planted.id && correction.id.startsWith("gotcha-"),
);

// -- read-back: recall surfaces the re-grade ---------------------------------
const cards = await call("mem_card_list", { scopePhase: 1 });
const plantedNow = cards.find((c) => c.id === planted.id);
check(
  "recall surfaces low confidence on the down-ranked card",
  plantedNow?.frontmatter?.confidence === "low",
);
const stats = await call("mem_stats");
check(
  "banner re-rendered (stats report banner tokens)",
  typeof stats.bannerTokens === "number",
);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
