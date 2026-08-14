#!/usr/bin/env node

// Purpose: Tier C2 probe drill (mechanical) — the full spike loop per
//          verbs/probe.md against the REAL dist server + REAL tracker:
//          experiment → result → requirement → verdict, cold-kill mid-spike
//          and fresh-client resume with counts intact, close `proceed`,
//          three-comment story leak-clean, and --wrap mechanics producing a
//          real .claude/skills/ package with provenance.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  buildPatterns,
  scanLines,
} from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const connect = async (name) => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    cwd: PROJECT,
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
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

const DESC = "drill: can the export pipeline stream 1M rows without buffering?";

// -- session one: spike loop, riskiest first --------------------------------
console.log("opening probe session (session one)...");
let c1 = await connect("probe-drill-1");
const started = await call(c1, "probe_start", { description: DESC });
check(
  "probe_start: session + real cairn:spike issue",
  Boolean(started.id) && Boolean(started.issue),
  JSON.stringify(started.__error ?? "").slice(0, 100),
);

const issue = await call(c1, "issue_get", { id: started.issue });
check(
  "spike issue: label cairn:spike, open",
  issue.labels?.includes("cairn:spike") && issue.state === "open",
);

const mirror1 =
  "Investigation started: checking whether the export pipeline can stream a million rows without loading them all into memory. Riskiest assumption first.";
await call(c1, "issue_comment", { id: started.issue, text: mirror1 });

// throwaway artifact lives beside the session
const artifactDir = join(PROJECT, ".cairn", "probe", started.id);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(
  join(artifactDir, "stream-poc.mjs"),
  "// throwaway: streams fake rows, prints peak RSS\n",
);

await call(c1, "probe_log", {
  id: started.id,
  kind: "experiment",
  text: "stream-poc.mjs pipes 1M synthetic rows through the export transform; validates memory stays flat.",
});
await call(c1, "probe_log", {
  id: started.id,
  kind: "result",
  text: "Peak RSS flat at ~60MB through 1M rows — but backpressure stalls at the gzip step every ~100k rows. Surprise: the stall clears itself; latency spikes, memory does not.",
});
await call(c1, "probe_log", {
  id: started.id,
  kind: "requirement",
  text: "Real build must surface backpressure stalls as progress events — silent 2s stalls are unacceptable UX.",
});

const midList = await call(c1, "session_landscape", {});
const mid = midList.sessions?.find((s) => s.id === started.id);
check(
  "mid-spike: open, counts 1/1/1/0",
  mid?.status === "open" &&
    mid.entryCounts?.experiment === 1 &&
    mid.entryCounts?.result === 1 &&
    mid.entryCounts?.requirement === 1 &&
    mid.entryCounts?.verdict === 0,
);

// -- cold-kill, fresh client resumes from the file --------------------------
console.log("cold-killing session one...");
await c1.close();

console.log("session two resumes...");
const c2 = await connect("probe-drill-2");
const resumed = (await call(c2, "session_landscape", {})).sessions?.find(
  (s) => s.id === started.id,
);
check(
  "resume: counts intact, zero re-derived results",
  resumed?.entryCounts?.experiment === 1 &&
    resumed?.entryCounts?.result === 1 &&
    resumed?.entryCounts?.requirement === 1,
);

const sessionFile = join(PROJECT, ".cairn", "probe", `${started.id}.md`);
const lastHeader = [
  ...readFileSync(sessionFile, "utf8").matchAll(
    /^## (experiment|result|requirement|verdict) — /gm,
  ),
].at(-1)?.[1];
check(
  "resume: last entry exactly where the kill landed",
  lastHeader === "requirement",
);

// -- verdict gate + close proceed -------------------------------------------
const premature = await call(c2, "probe_close", {
  id: started.id,
  resolution: "proceed",
});
check(
  "verdict gate: close without verdict refused",
  Boolean(premature.__error),
);

const mirror2 =
  "Key finding: streaming holds memory flat at a million rows. One catch — the compression step stalls briefly every hundred thousand rows, so the real build needs progress reporting.";
await call(c2, "issue_comment", { id: started.issue, text: mirror2 });
await call(c2, "probe_log", {
  id: started.id,
  kind: "verdict",
  text: "VALIDATED — streaming approach holds; backpressure stalls are a UX issue, not a memory issue.",
});

const RESOLUTION =
  "proceed — streaming export is viable; carry the progress-event requirement into the real build.";
const closed = await call(c2, "probe_close", {
  id: started.id,
  resolution: RESOLUTION,
});
check(
  "probe_close: resolved, issue closed",
  closed.issueClosed === true && closed.gateTexts?.length === 1,
);
check(
  "archive: live file gone, archive present",
  !existsSync(sessionFile) &&
    existsSync(join(PROJECT, ".cairn", "probe", "archive", `${started.id}.md`)),
);
check(
  "tracker: issue closed",
  (await call(c2, "issue_get", { id: started.issue })).state === "closed",
);

// -- --wrap mechanics: package a real skill with provenance ------------------
console.log("wrap mechanics: packaging the spike into a skill...");
const archive = readFileSync(
  join(PROJECT, ".cairn", "probe", "archive", `${started.id}.md`),
  "utf8",
);
const skillDir = join(PROJECT, ".claude", "skills", "streaming-export");
mkdirSync(join(skillDir, "references"), { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  [
    "---",
    "name: streaming-export",
    "description: Validated streaming-export approach — flat memory at 1M rows; surface backpressure stalls as progress events",
    "---",
    "",
    "## What was validated",
    ...archive
      .split("\n")
      .filter((l) => l.startsWith("VALIDATED") || l.includes("Peak RSS")),
    "",
    "## What to avoid",
    "- Silent backpressure stalls — surface them as progress events.",
    "",
    "## Origin",
    `- session: ${started.id}`,
    `- tracker issue: ${started.issue}`,
    `- files: .cairn/probe/${started.id}/stream-poc.mjs`,
    "",
  ].join("\n"),
);
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
check(
  "wrap: package exists with provenance (session id + issue + files)",
  skill.includes(started.id) &&
    skill.includes(started.issue) &&
    skill.includes("stream-poc.mjs"),
);

// -- comment story: plain language, leak-clean -------------------------------
const token =
  process.env.GITHUB_TOKEN ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const repo = JSON.parse(readFileSync(join(PROJECT, "cairn.json"), "utf8"))
  .tracker.config.repo;
const res = await fetch(
  `https://api.github.com/repos/${repo}/issues/${started.issue.split("/").pop()}/comments`,
  {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
  },
);
const comments = (await res.json()).map((c) => c.body);
check(
  "story: three comments in order (started → finding → resolved)",
  comments.length === 3 &&
    comments[0] === mirror1 &&
    comments[1] === mirror2 &&
    comments[2] === `Resolved: ${RESOLUTION}`,
);
const hits = scanLines(
  comments.flatMap((c) => c.split("\n")),
  buildPatterns(null),
);
check(
  "leak scan: zero pattern hits",
  hits.length === 0,
  hits.map((h) => h.name).join(","),
);

await c2.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
