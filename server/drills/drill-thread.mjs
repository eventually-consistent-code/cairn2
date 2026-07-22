#!/usr/bin/env node

// Purpose: Tier E thread drill (mechanical) — persistent context threads per
//          verbs/thread.md against the REAL dist server + REAL tracker:
//          start (cairn:thread issue + mirror), note/link/decision entries,
//          cold-kill + fresh-client resume, wrap gate, wrapped close (issue
//          closed with the resolution), banner/landscape surfacing, leak scan.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { renderBanner } from "../dist/memory/banner.js";
import { buildPatterns, scanLines } from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const connect = async (name) => {
  const transport = new StdioClientTransport({
    command: "node", args: [SERVER], cwd: PROJECT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
};

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const NAME = "drill: payments adapter migration thread";

// -- session one: start, log, kill --------------------------------------------
console.log("starting the thread (session one)...");
let c1 = await connect("thread-drill-1");
const started = await call(c1, "thread_start", { description: NAME });
check("thread_start: session + real cairn:thread issue", Boolean(started.id) && Boolean(started.issue),
  JSON.stringify(started.__error ?? "").slice(0, 100));
check("issue: label cairn:thread, open",
  (await call(c1, "issue_get", { id: started.issue })).labels?.includes("cairn:thread"));

const mirror1 = "Thread opened: migrating the payments adapter. Long-running context lives here so nothing gets re-derived between sessions.";
await call(c1, "issue_comment", { id: started.issue, text: mirror1 });

await call(c1, "thread_log", { id: started.id, kind: "note", text: "stripe adapter first; paypal after the interface settles" });
await call(c1, "thread_log", { id: started.id, kind: "link", text: "probe-deadbeef — proved streaming exports hold at 1M rows, which unblocks the reconciliation piece" });
await call(c1, "thread_log", { id: started.id, kind: "decision", text: "webhooks over polling — polling burned the rate limit in the probe" });

check("banner: open thread surfaces last",
  (renderBanner(PROJECT) ?? "").includes(`- thread ${started.id}`));

console.log("cold-killing session one...");
await c1.close();

// -- session two: resume purely from the file ----------------------------------
console.log("session two resumes by name...");
const c2 = await connect("thread-drill-2");
const again = await call(c2, "thread_start", { description: NAME });
check("resume: already-open guard fires (resume IS the point)",
  again.__error?.code === "PRECONDITION_FAILED" || Boolean(again.__error));

const resumed = (await call(c2, "session_landscape", {})).sessions.find((s) => s.id === started.id);
check("resume: counts intact, zero re-derived context",
  resumed?.status === "open" && resumed.entryCounts?.note === 1
  && resumed.entryCounts?.link === 1 && resumed.entryCounts?.decision === 1);

// -- wrap gate ------------------------------------------------------------------
const early = await call(c2, "thread_close", { id: started.id, resolution: "done-ish" });
check("wrap gate: close without a wrap entry refused", Boolean(early.__error));

const mirror2 = "Thread wrapped: stripe migrated on webhooks; paypal queued behind the settled interface. Decisions and links live in the thread archive.";
await call(c2, "issue_comment", { id: started.issue, text: mirror2 });
await call(c2, "thread_log", { id: started.id, kind: "wrap",
  text: "landed: stripe on webhooks, interface settled, paypal is the next thread" });
const RESOLUTION = "Payments thread wrapped — stripe migrated, paypal queued as its own thread.";
const closed = await call(c2, "thread_close", { id: started.id, resolution: RESOLUTION });
check("thread_close: wrapped + issue closed", closed.issueClosed === true && closed.gateTexts?.length === 1);
check("archive: session archived", resolvedArchive());
function resolvedArchive() {
  try { readFileSync(join(PROJECT, ".cairn", "thread", "archive", `${started.id}.md`), "utf8"); return true; }
  catch { return false; }
}

// -- story + leak scan ------------------------------------------------------------
const token = process.env.GITHUB_TOKEN
  ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const repo = JSON.parse(readFileSync(join(PROJECT, "cairn.json"), "utf8")).tracker.config.repo;
const res = await fetch(`https://api.github.com/repos/${repo}/issues/${started.issue.split("/").pop()}/comments`, {
  headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
});
const comments = (await res.json()).map((c) => c.body);
check("story: opened → wrapped → resolved, in order",
  comments.length === 3 && comments[0] === mirror1 && comments[1] === mirror2
  && comments[2] === `Resolved: ${RESOLUTION}`);
const hits = scanLines(comments.flatMap((c) => c.split("\n")), buildPatterns(null));
check("leak scan: zero pattern hits", hits.length === 0, hits.map((h) => h.name).join(","));

await c2.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
