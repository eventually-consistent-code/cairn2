#!/usr/bin/env node

// Purpose: Tier E backtrack drill (mechanical) — the safe-undo flow per
//          verbs/backtrack.md in a LOCAL scratch git repo (no tracker):
//          ledgered commit range → revert set, overlapping later commit
//          flagged file-by-file, apply leg reverts newest-first with the
//          original shas intact — no history rewrite anywhere.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const git = (...args) => execFileSync("git", ["-C", PROJECT, ...args], { encoding: "utf8" }).trim();
const commit = (file, content, msg) => {
  writeFileSync(join(PROJECT, file), content);
  git("add", file);
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// -- scratch repo with a ledgered phase ----------------------------------------
console.log("seeding a scratch repo: two ledgered task commits + one overlapping later commit...");
git("init", "-q", "-b", "main");
git("config", "user.email", "drill@example.invalid");
git("config", "user.name", "drill");
const c0 = commit("a.txt", "v1\n", "base");
const c1 = commit("a.txt", "v2\n", "task 1: rework a");
const c2 = commit("b.txt", "b-v1\n", "task 2: add b");
const later = commit("b.txt", "b-v2 overlap\n", "later work touching b");

mkdirSync(join(PROJECT, ".cairn", "plans", "phases", "01-drill"), { recursive: true });
const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "backtrack-drill", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const led = await call("ledger_append", {
  phaseDir: "01-drill", taskRef: "task-1..2", summary: "rework a, add b",
  baseCommit: c0, headCommit: c2, issueId: "GH-drill", closedDate: "2026-07-22",
});
check("ledger: range appended via ledger_append", !led.__error,
  JSON.stringify(led.__error ?? "").slice(0, 100));

// -- compute the revert set from the ledger (the verb's read) --------------------
const ledger = readFileSync(join(PROJECT, ".cairn", "plans", "phases", "01-drill", "LEDGER.md"), "utf8");
const range = /commits ([0-9a-f]{7})\.\.([0-9a-f]{7})/.exec(ledger);
check("revert set: ledger names the exact range", range?.[1] === c0.slice(0, 7) && range?.[2] === c2.slice(0, 7));
const revertSet = git("rev-list", "--reverse", `${range[1]}..${range[2]}`).split("\n");
check("revert set: exactly the two task commits", revertSet.length === 2
  && revertSet[0] === c1 && revertSet[1] === c2);

// -- overlap check: later commits touching the same files ------------------------
const manifestFiles = new Set(
  revertSet.flatMap((sha) => git("show", "--name-only", "--format=", sha).split("\n").filter(Boolean)));
const laterCommits = git("rev-list", `${range[2]}..HEAD`).split("\n").filter(Boolean);
const overlaps = [];
for (const sha of laterCommits) {
  for (const f of git("show", "--name-only", "--format=", sha).split("\n").filter(Boolean)) {
    if (manifestFiles.has(f)) overlaps.push({ sha, file: f });
  }
}
check("overlap: later commit flagged file-by-file",
  overlaps.length === 1 && overlaps[0].sha === later && overlaps[0].file === "b.txt");

// -- apply leg: revert newest-first, shas intact ---------------------------------
// b.txt overlaps a later commit — per backtrack.md that file needs manual review;
// the drill reverts the NON-overlapping part mechanically (c1 only) to prove the
// apply mechanics, exactly what the verb would do after the user excludes b.txt.
console.log("apply leg: reverting the non-overlapping commit...");
const headBefore = git("rev-parse", "HEAD");
git("revert", "--no-edit", c1);
check("apply: revert commit created, a.txt back to v1",
  readFileSync(join(PROJECT, "a.txt"), "utf8") === "v1\n");
check("apply: original shas intact — reverts only, no rewrite",
  git("rev-parse", `${headBefore}^{commit}`) === headBefore
  && git("rev-list", "HEAD").split("\n").includes(c1)
  && git("log", "-1", "--format=%s").startsWith("Revert"));
check("apply: overlapping file untouched by the revert",
  readFileSync(join(PROJECT, "b.txt"), "utf8") === "b-v2 overlap\n");

// record the run (the verb's closing discipline)
const rec = await call("audit_record", { scope: "backtrack-01-drill", verdict: "findings",
  findings: [{ severity: "important", title: "b.txt overlaps later work — excluded from revert, needs manual review" }] });
check("record: backtrack run recorded", rec.findings === 1);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
