#!/usr/bin/env node

// Purpose: Tier D triage drill (mechanical) — the sweep per verbs/triage.md
//          against the REAL dist server + REAL tracker. Stages the rot:
//          unlabeled, bodiless, a reopened cairn:bug whose trace archive
//          names its resolution, and a near-duplicate pair. Report leg
//          mutates nothing; apply leg fixes only the safe subset with
//          evidence quoted; leak scan zero hits; same-day re-run supersedes.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildPatterns, scanLines } from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node", args: [SERVER], cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "triage-drill", version: "0.0.0" });
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
const today = new Date().toISOString().slice(0, 10);

// -- stage the rot ------------------------------------------------------------
console.log("staging rot on the tracker...");
const unlabeled = await call("issue_create", {
  title: "flaky retry needs a deadline", body: "seen twice in CI this week" });
const bodiless = await call("issue_create", {
  title: "tune the cache TTLs", labels: ["cairn:backlog"] });
const dupA = await call("issue_create", {
  title: "export button unresponsive on large datasets", labels: ["cairn:backlog"],
  body: "clicking export with 100k rows does nothing" });
const dupB = await call("issue_create", {
  title: "export button does nothing on large data sets", labels: ["cairn:backlog"],
  body: "no response from export at six figures of rows" });

// the reopened bug: trace resolved + closed it, then someone reopened it
const bug = await call("issue_create", {
  title: "drill: pagination skips first row after sort", labels: ["cairn:bug"],
  body: "critical\nSort then paginate loses row one." });
const trace = await call("trace_start", {
  description: "drill: pagination skips first row after sort", issueId: bug.id });
await call("trace_log", { id: trace.id, kind: "evidence", text: "reproduced on any sorted column" });
await call("trace_log", { id: trace.id, kind: "verdict",
  text: "Cause: cursor off-by-one after re-sort. Fix: cursor reset on sort change. Commit: aaa1111." });
const RESOLUTION = "Cursor now resets when sort changes, so page one starts at row one.";
await call("trace_close", { id: trace.id, resolution: RESOLUTION });
await call("issue_update", { id: bug.id, state: "open" });
check("staged: cairn:bug reopened after its trace resolved",
  (await call("issue_get", { id: bug.id })).state === "open");

// -- report leg: classify, record, mutate NOTHING -----------------------------
// NOTE: GitHub's list endpoint is read-after-write inconsistent — issues
// created seconds ago may be missing. Real triage sweeps an aged tracker so
// issue_list is correct there; the DRILL pins classification on issue_get
// (read-after-write consistent) and only proves issue_list answers.
console.log("report leg: sweep with zero tracker mutations...");
const listed = await call("issue_list", { state: "open" });
check("issue_list answers with an array", Array.isArray(listed));
const open = [];
for (const staged of [bug, unlabeled, bodiless, dupA, dupB]) {
  open.push(await call("issue_get", { id: staged.id }));
}
const scape = await call("session_landscape", {});
const resolvedTrace = scape.sessions.find((s) => s.id === trace.id);
check("evidence: landscape carries the trace resolution", resolvedTrace?.resolution === RESOLUTION);

const findings = [];
for (const i of open) {
  if (i.labels.includes("cairn:bug") && resolvedTrace && i.id === bug.id) {
    findings.push({ severity: "important",
      title: "reopened after its trace named a resolution", issue: i.id });
  } else if (i.labels.length === 0 && [unlabeled.id].includes(i.id)) {
    findings.push({ severity: "minor", title: "unlabeled", issue: i.id });
  } else if ((i.body ?? "") === "" && i.id === bodiless.id) {
    findings.push({ severity: "minor", title: "bodiless", issue: i.id });
  } else if ([dupA.id, dupB.id].includes(i.id)) {
    findings.push({ severity: "minor", title: "possible duplicate of its export-button twin", issue: i.id });
  }
}
const rec1 = await call("audit_record", { scope: "triage", verdict: "findings", findings });
check("record written, findings linked to real issue ids",
  rec1.findings === findings.length && findings.every((f) => f.issue),
  JSON.stringify(rec1.__error ?? "").slice(0, 100));
check("report leg staged all five: 1 important + 4 minors",
  findings.filter((f) => f.severity === "important").length === 1 && findings.length === 5,
  JSON.stringify(findings.map((f) => f.title)));

const bugAfterReport = await call("issue_get", { id: bug.id });
const unlabeledAfterReport = await call("issue_get", { id: unlabeled.id });
check("report leg mutated nothing (bug still open, unlabeled still bare)",
  bugAfterReport.state === "open" && unlabeledAfterReport.labels.length === 0);

// -- apply leg: the safe subset only ------------------------------------------
console.log("apply leg: safe subset...");
// unlabeled → best-fit label FROM THE EXISTING VOCABULARY
const vocab = [...new Set([...listed, ...open].flatMap((i) => i.labels))];
check("label vocabulary read from the project, non-empty", vocab.includes("cairn:backlog"));
await call("issue_update", { id: unlabeled.id, labels: ["cairn:backlog"] });
check("unlabeled: labeled from existing set only",
  (await call("issue_get", { id: unlabeled.id })).labels.includes("cairn:backlog"));

// resolved-but-open → evidence-quoting comment, then close
const closeNote = `Closing: this was resolved by trace ${trace.id} — "${RESOLUTION}" If the bug is back, open a fresh trace rather than reopening this thread.`;
await call("issue_comment", { id: bug.id, text: closeNote });
await call("issue_close", { id: bug.id });
check("resolved-but-open: closed with the evidence quoted",
  (await call("issue_get", { id: bug.id })).state === "closed");

// duplicates → cross-linked, BOTH STAY OPEN
await call("issue_comment", { id: dupA.id, text: `Possible duplicate of ${dupB.id} — same export-button symptom. Flagging for a human call, not closing either.` });
await call("issue_comment", { id: dupB.id, text: `Possible duplicate of ${dupA.id} — same export-button symptom. Flagging for a human call, not closing either.` });
const dupsOpen = (await call("issue_get", { id: dupA.id })).state === "open"
  && (await call("issue_get", { id: dupB.id })).state === "open";
check("duplicates: cross-linked, both still open", dupsOpen);

// bodiless → untouched, always
const bodilessAfter = await call("issue_get", { id: bodiless.id });
check("bodiless: untouched (body still empty, still open)",
  (bodilessAfter.body ?? "") === "" && bodilessAfter.state === "open");

// -- same-day supersede ---------------------------------------------------------
const rec2 = await call("audit_record", { scope: "triage", verdict: "findings",
  findings: findings.filter((f) => f.severity === "minor" && f.title !== "unlabeled") });
const raw2 = readFileSync(join(PROJECT, ".cairn", "audit", `triage-${today}.md`), "utf8");
check("same-day re-run supersedes the record", !raw2.includes("reopened after its trace"));

// -- leak scan over everything sent -----------------------------------------------
const sent = [closeNote,
  `Possible duplicate of ${dupB.id} — same export-button symptom. Flagging for a human call, not closing either.`];
const hits = scanLines(sent.flatMap((t) => t.split("\n")), buildPatterns(null));
check("leak scan: zero pattern hits in tracker text", hits.length === 0, hits.map((h) => h.name).join(","));

// cleanup: close the staged clutter so the scratch repo ends tidy
for (const id of [unlabeled.id, bodiless.id, dupA.id, dupB.id]) await call("issue_close", { id });

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
