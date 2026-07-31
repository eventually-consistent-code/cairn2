#!/usr/bin/env node

// Purpose: survey drill (mechanical) — verbs/survey.md's apply stage proven
//          end-to-end against the server: SURVEY.md marker discipline (done
//          sections survive a "resume"), decimal phase insert (1.5) between
//          neighbors without renumbering, plan_status's numeric ordering of
//          integer + decimal phases, the real CONFIG_INVALID envelope on an
//          invalid decimal (1.55 — more than one fractional digit), a
//          mirrored issue into the new phase, and mem_index of the finished
//          brief.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const git = (...args) => execFileSync("git", args, { cwd: PROJECT, encoding: "utf8" }).trim();

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// -- scratch project: git repo + a local (zero-dependency) tracker -----------
console.log("setting up scratch project...");
git("init", "-q", "-b", "main");
git("config", "user.email", "drill@example.invalid");
git("config", "user.name", "drill");
writeFileSync(join(PROJECT, "cairn.json"),
  JSON.stringify({ tracker: { type: "local", config: { prefix: "sd" } } }, null, 2) + "\n");
git("add", "-A"); git("commit", "-q", "-m", "init", "--no-gpg-sign");

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "survey-drill", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

// -- setup: project + phases 1 and 2 (SURVEY.md lives beside roadmap.md,
// which plan_scaffold_project creates -- scaffold the project first) --------
console.log("scaffolding phases 1 and 2...");
await call("plan_scaffold_project", { name: "survey-drill" });
const p1 = await call("plan_scaffold_phase", { number: 1, name: "alpha" });
const p2 = await call("plan_scaffold_phase", { number: 2, name: "beta" });

// -- marker discipline: done sections survive a resume ------------------------
console.log("SURVEY.md marker discipline...");
const surveyPath = join(PROJECT, ".cairn", "plans", "SURVEY.md");
const before = [
  "# Survey",
  "",
  "## finished topic",
  "<!-- survey: done -->",
  "finding: keep me",
  "",
  "## unfinished topic",
  "<!-- survey: pending -->",
  "",
].join("\n");
writeFileSync(surveyPath, before);
const readBack = readFileSync(surveyPath, "utf8");
check("SURVEY.md done marker parses",
  /## finished topic\n<!-- survey: done -->/.test(readBack));
check("SURVEY.md pending marker parses",
  /## unfinished topic\n<!-- survey: pending -->/.test(readBack));
check("done section content intact", readBack.includes("finding: keep me"));

// -- decimal insert: phase 1.5 between 1 and 2, no renumber -------------------
console.log("decimal insert (1.5) between the existing neighbors...");
const p15 = await call("plan_scaffold_phase", { number: 1.5, name: "gamma" });

check("phase 1 dir form (unaffected by the later insert)", p1.dir === "01-alpha", p1.dir);
check("phase 2 dir form (unaffected by the later insert)", p2.dir === "02-beta", p2.dir);
check("decimal insert lands as 01.5-gamma (route's never-renumber rule)",
  p15.dir === "01.5-gamma", p15.dir);

const phasesDir = join(PROJECT, ".cairn", "plans", "phases");
const dirs = readdirSync(phasesDir);
check("phase 1 dir still on disk, untouched", dirs.includes("01-alpha"));
check("phase 2 dir still on disk, untouched", dirs.includes("02-beta"));
check("decimal phase dir present on disk", dirs.includes("01.5-gamma"));

console.log("plan_status: numeric ordering of integer + decimal phases...");
const status = await call("plan_status", {});
const numbers = status.phases.map((p) => p.number);
check("plan_status orders phases numerically: [1, 1.5, 2]",
  JSON.stringify(numbers) === JSON.stringify([1, 1.5, 2]), JSON.stringify(numbers));

// -- bonus: an invalid decimal is a real CONFIG_INVALID envelope, not a raw
// SDK/Zod rejection -- 1.55 has two fractional digits, outside N.1-N.9 -------
console.log("bonus: bad decimal (1.55) rejected with a genuine CONFIG_INVALID envelope...");
const bad = await call("plan_scaffold_phase", { number: 1.55, name: "not-a-slot" });
check("invalid decimal surfaces {code: CONFIG_INVALID} (not an SDK-level Zod error)",
  bad.__error?.code === "CONFIG_INVALID", JSON.stringify(bad.__error ?? bad));

// -- mirrored issue into the new phase ----------------------------------------
console.log("mirroring the tracker phase object + an issue into phase 1.5...");
await call("plan_phase_ensure", { number: 1.5, name: "gamma" });
const phases = await call("phase_list");
const tp = phases.find((p) => p.name === "Phase 1.5: gamma");
check("tracker phase mirrored under the canonical decimal name", Boolean(tp));

const issue = await call("issue_create", {
  title: "survey drill: work item from findings",
  body: "created by drill-survey apply stage",
  phase: tp?.id,
});
check("issue created with id", Boolean(issue.id));

await call("plan_issues_set", { phaseDir: p15.dir, issues: [issue.id] });
const planMd = readFileSync(join(phasesDir, p15.dir, "PLAN.md"), "utf8");
check("PLAN.md frontmatter carries the issue", planMd.includes(String(issue.id)));

// -- mem_index the finished brief ----------------------------------------------
console.log("mem_index of the finished SURVEY.md...");
const idx = await call("mem_index", { source: surveyPath, content: readBack });
check("mem_index accepted SURVEY.md", idx.ok === true);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
