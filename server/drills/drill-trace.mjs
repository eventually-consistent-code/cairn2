#!/usr/bin/env node

// Purpose: Tier C1 trace lifecycle drill (mechanical) — full evidence →
//          hypothesis → test → verdict flow per verbs/trace.md against the
//          REAL dist server + REAL tracker. Kills the client mid-session and
//          resumes fresh to prove the session file survives with zero
//          re-derived evidence. Pass condition: three tracker comments tell
//          the whole story in plain language with zero leak-pattern hits,
//          issue closes with the resolution, session archives, gotcha card
//          recalls with provenance intact.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { renderBanner } from "../dist/memory/banner.js";
import { handoffPath } from "../dist/core/continuity.js";
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

const DESC = "drill: retry loop double-fires on 502 responses";

// -- session one: start, mirror, investigate --------------------------------
console.log("opening trace session (session one)...");
let c1 = await connect("trace-drill-1");
const started = await call(c1, "trace_start", { description: DESC });
check("trace_start: session + real bug issue", Boolean(started.id) && Boolean(started.issue),
  JSON.stringify(started.__error ?? "").slice(0, 100));

const issue = await call(c1, "issue_get", { id: started.issue });
check("bug issue: label cairn:bug, open", issue.labels?.includes("cairn:bug") && issue.state === "open");

const mirror1 = "Investigation started: retries are firing twice when the tracker returns a 502. Reproducing before any theory.";
const posted1 = await call(c1, "issue_comment", { id: started.issue, text: mirror1 });
check("mirror comment #1: investigation started", !posted1.__error);

await call(c1, "trace_log", { id: started.id, kind: "evidence",
  text: "Reproduced: two POSTs land 40ms apart on a mocked 502. Log shows retry scheduled by both the fetch wrapper and the queue worker." });
await call(c1, "trace_log", { id: started.id, kind: "hypothesis",
  text: "Both layers own retry policy — the wrapper retries in-band while the queue re-enqueues the same job." });
await call(c1, "trace_log", { id: started.id, kind: "test",
  text: "Disable wrapper retry behind a flag; if the double-fire stops, ownership overlap is confirmed. This can disprove the hypothesis." });

const midList = await call(c1, "trace_list", { status: "open" });
const mid = midList.find?.((t) => t.id === started.id);
check("mid-session: open with 1/1/1/0 entry counts",
  mid?.entryCounts?.evidence === 1 && mid?.entryCounts?.hypothesis === 1
  && mid?.entryCounts?.test === 1 && mid?.entryCounts?.verdict === 0);

const banner = renderBanner(PROJECT);
check("banner: open trace surfaces", typeof banner === "string" && banner.includes(started.id));
check("handoff: written by trace tools", existsSync(handoffPath(PROJECT)));

// -- kill session one, resume fresh -----------------------------------------
console.log("killing session one (no goodbye)...");
await c1.close();

console.log("session two resumes from the file...");
const c2 = await connect("trace-drill-2");
const resumedList = await call(c2, "trace_list", { status: "open" });
const resumed = resumedList.find?.((t) => t.id === started.id);
check("resume: trace intact, zero re-derived evidence",
  resumed?.entryCounts?.evidence === 1 && resumed?.entryCounts?.hypothesis === 1
  && resumed?.entryCounts?.test === 1);

const sessionFile = join(PROJECT, ".cairn", "trace", `${started.id}.md`);
const body = readFileSync(sessionFile, "utf8");
const lastHeader = [...body.matchAll(/^## (evidence|hypothesis|test|verdict) — /gm)].at(-1)?.[1];
check("resume: last entry is exactly where we left off", lastHeader === "test");

// -- verdict gate: close refuses without a verdict --------------------------
const premature = await call(c2, "trace_close", { id: started.id, resolution: "nope" });
check("verdict gate: close without verdict refused",
  premature.__error?.code === "PRECONDITION_FAILED" || Boolean(premature.__error));

// -- cause found, verdict, close --------------------------------------------
const mirror2 = "Cause identified: two layers both owned retry — the request wrapper and the queue worker each retried the same failed call.";
await call(c2, "issue_comment", { id: started.issue, text: mirror2 });

await call(c2, "trace_log", { id: started.id, kind: "verdict",
  text: "Cause: overlapping retry ownership (wrapper + queue). Fix: retry lives in the queue only; wrapper fails fast. Commit: abc1234." });

const RESOLUTION = "Retries now happen in one place (the queue). The wrapper fails fast, so a 502 produces exactly one retry.";
const closed = await call(c2, "trace_close", { id: started.id, resolution: RESOLUTION });
check("trace_close: resolved + tracker issue closed", closed.issueClosed === true && closed.verdicts?.length === 1);

const after = await call(c2, "issue_get", { id: started.issue });
check("bug issue: closed on tracker", after.state === "closed");
check("archive: session file moved, live file gone",
  !existsSync(sessionFile) && existsSync(join(PROJECT, ".cairn", "trace", "archive", `${started.id}.md`)));

// -- gotcha card with provenance --------------------------------------------
const card = await call(c2, "mem_card_create", {
  type: "gotcha", confidence: "high",
  body: "Retry policy must have exactly one owner — wrapper-level and queue-level retries stack into double-fires on 5xx.",
  provenanceFiles: ["src/queue/worker.ts"], provenanceCommits: ["abc1234"],
});
check("gotcha card: created with provenance", card.id?.startsWith("gotcha-") === true);
const recalled = await call(c2, "mem_card_recall", {});
check("gotcha card: recallable in a later session",
  Array.isArray(recalled) && recalled.some((c) => (c.card?.id ?? c.id) === card.id));

// -- the three comments tell the story, leak-clean --------------------------
console.log("reading the mirror comments back...");
const token = process.env.GITHUB_TOKEN
  ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const repo = JSON.parse(readFileSync(join(PROJECT, "cairn.json"), "utf8")).tracker.config.repo;
const num = started.issue.split("/").pop();
const res = await fetch(`https://api.github.com/repos/${repo}/issues/${num}/comments`, {
  headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
});
const comments = (await res.json()).map((c) => c.body);
check("story: three comments in order (started → cause → resolved)",
  comments.length === 3 && comments[0] === mirror1 && comments[1] === mirror2
  && comments[2] === `Resolved: ${RESOLUTION}`);

const hits = scanLines(comments.flatMap((c) => c.split("\n")), buildPatterns(null));
check("leak scan: zero pattern hits across all comment text", hits.length === 0,
  hits.map((h) => h.name).join(","));

await c2.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
