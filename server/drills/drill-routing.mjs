#!/usr/bin/env node

// Purpose: Tier C1 routing drill (mechanical) — the #726 hard route and the
//          fast lane per verbs/verify.md. Hard route: a failed verify enters
//          trace with the failure itself as evidence entry #1 — never an
//          improvised inline fix. Fast lane: a proven-obvious fix is ONE
//          motion (start → evidence → verdict → close) with both mirror
//          touches present. Also greps the verb docs to pin the routing
//          edits themselves.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);
const VERBS = resolve(
  process.argv[4] ??
    join(SERVER, "..", "..", "..", "skills", "cairn-trailhead", "verbs"),
);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "routing-drill", version: "0.0.0" });
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

const readComments = async (issueId) => {
  const token =
    process.env.GITHUB_TOKEN ??
    execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const repo = JSON.parse(readFileSync(join(PROJECT, "cairn.json"), "utf8"))
    .tracker.config.repo;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueId.split("/").pop()}/comments`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    },
  );
  return (await res.json()).map((c) => c.body);
};

// -- the routing edits exist in the verb docs -------------------------------
console.log("pinning the routing edits in the verb docs...");
for (const verb of ["verify", "work", "auto"]) {
  const doc = readFileSync(join(VERBS, `${verb}.md`), "utf8");
  check(`${verb}.md: routes failures into trace`, /trace/i.test(doc));
}
const statusDoc = readFileSync(join(VERBS, "status.md"), "utf8");
check("status.md: surfaces open traces", /trace/i.test(statusDoc));

// -- hard route: failed verify becomes evidence entry #1 --------------------
console.log("hard route: rigged verify failure enters trace...");
const FAILURE =
  "verify FAILED on task 3: expected exit 0 from `npm test`, got 1 — 2 assertions failing in staleness.test.ts";
const hard = await call("trace_start", {
  description: "drill: verify failure on task 3 (hard route)",
});
check(
  "hard route: trace opened for the failure",
  Boolean(hard.id) && Boolean(hard.issue),
  JSON.stringify(hard.__error ?? "").slice(0, 100),
);
await call("issue_comment", {
  id: hard.issue,
  text: "Investigation started: task 3 verification failed — two test assertions are off. Digging in before touching anything.",
});
await call("trace_log", { id: hard.id, kind: "evidence", text: FAILURE });

const hardFile = readFileSync(
  join(PROJECT, ".cairn", "trace", `${hard.id}.md`),
  "utf8",
);
const firstEntry = /^## (evidence|hypothesis|test|verdict) — /m.exec(
  hardFile,
)?.[1];
check(
  "hard route: failure IS evidence entry #1",
  firstEntry === "evidence" && hardFile.includes(FAILURE),
);

// no inline fix: the verdict (with the fix) only lands inside the trace flow
const hardEarly = await call("trace_close", {
  id: hard.id,
  resolution: "patched it, probably fine",
});
check(
  "hard route: no patch-and-rerun exit — close still gated on a verdict",
  Boolean(hardEarly.__error),
);
await call("trace_log", {
  id: hard.id,
  kind: "verdict",
  text: "Cause: staleness window widened by DST shift in fixture dates. Fix: fixtures pinned to UTC. Commit: def5678.",
});
const hardClosed = await call("trace_close", {
  id: hard.id,
  resolution:
    "Test fixtures now use UTC dates, so the staleness window no longer shifts with local DST.",
});
check(
  "hard route: resolved through the trace, issue closed",
  hardClosed.issueClosed === true,
);

// -- fast lane: proven-obvious fix in ONE motion ----------------------------
console.log("fast lane: <=3-line fix, one motion, full paper trail...");
const fast = await call("trace_start", {
  description: "drill: off-by-one in pagination cursor (fast lane)",
});
await call("issue_comment", {
  id: fast.issue,
  text: "Investigation started: pagination skips the first item on page two — classic off-by-one, fix is obvious.",
});
await call("trace_log", {
  id: fast.id,
  kind: "evidence",
  text: "Page 2 starts at index 21, not 20 — cursor computed as page*size+1.",
});
await call("trace_log", {
  id: fast.id,
  kind: "verdict",
  text: "Cause: cursor off-by-one. Fix: page*size, one line. Commit: 0123abc.",
});
const fastClosed = await call("trace_close", {
  id: fast.id,
  resolution:
    "Pagination cursor fixed — page two now starts exactly where page one ended.",
});
check(
  "fast lane: one motion start→evidence→verdict→close",
  fastClosed.issueClosed === true,
);

const fastList = await call("trace_list", { status: "resolved" });
const fastInfo = fastList.find?.((t) => t.id === fast.id);
check(
  "fast lane: complete session recorded despite single motion",
  fastInfo?.entryCounts?.evidence === 1 && fastInfo?.entryCounts?.verdict === 1,
);

const fastComments = await readComments(fast.issue);
check(
  "fast lane: both mirror touches (started + resolved close-note)",
  fastComments.length === 2 &&
    /^Investigation started:/.test(fastComments[0]) &&
    /^Resolved:/.test(fastComments[1]),
);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
