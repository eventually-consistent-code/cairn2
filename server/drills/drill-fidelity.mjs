#!/usr/bin/env node

// Purpose: Tracker-mirror fidelity + engineer-mode semi-live dogfood driver —
//          the VERIFICATION.md checklists walked through the verb docs' own
//          tool sequences against the REAL dist server, REAL GitHub tracker
//          (PM-side actions injected out-of-band via the gh CLI so they are
//          genuinely external), and the REAL SessionStart hook script, in a
//          scratch git repo. What it deliberately cannot cover: the
//          conversational halves (AskUserQuestion adoption/pairing prompts,
//          status render copy) and live Jira worklog — that residue is the
//          owner's live pass.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);
const REPO_SLUG = process.argv[4]; // owner/name of the scratch tracker repo
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const git = (...a) => execFileSync("git", ["-C", PROJECT, ...a], { encoding: "utf8" }).trim();
const gh = (...a) => execFileSync("gh", ["-R", REPO_SLUG, ...a], { encoding: "utf8" }).trim();

const connect = async (name) => {
  const t = new StdioClientTransport({ command: "node", args: [SERVER], cwd: PROJECT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT } });
  const c = new Client({ name, version: "0.0.0" });
  await c.connect(t);
  return c;
};
const mk = (c) => async (name, args = {}) => {
  const res = await c.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// GitHub reads can lag an out-of-band gh mutation by a few seconds — retry a
// probe until it comes true (or give up). Cadence, not correctness: the delta
// contract is "next scan sees it", not "the very next millisecond".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eventually = async (fn, tries = 10, delayMs = 3000) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(delayMs);
  }
  return false;
};

const baseConfig = {
  tracker: { type: "github", config: { repo: REPO_SLUG } },
  agents: { model: "auto" },
  continuity: { resume: "prompt", checkpoint: true, wipCommits: false,
    recallIndex: { enabled: true, maxCards: 20 } },
  leakGuard: { enabled: true, allow: [], extraPatterns: [] },
};
const writeConfig = (extra = {}) =>
  writeFileSync(join(PROJECT, "cairn.json"),
    JSON.stringify({ ...baseConfig, ...extra }, null, 2));

// -- scratch repo -------------------------------------------------------------
console.log("setting up scratch project...");
git("init", "-q", "-b", "main");
git("config", "user.email", "drill@example.invalid");
git("config", "user.name", "drill");
writeConfig();
writeFileSync(join(PROJECT, "README.md"), "# fidelity scratch\n");
git("add", "-A"); git("commit", "-q", "-m", "init");

let c = await connect("fidelity-1");
let call = mk(c);

// =============================================================================
// INBOUND — tracker delta ingest
// =============================================================================

// first run initializes the cursor and reports nothing
console.log("delta first run...");
const init = await call("plan_tracker_delta", {});
check("inbound: first run initializes cursor, reports nothing",
  init.initialized === true && init.new?.length === 0);

// cairn-side work that must NOT echo: scaffold + issue through the server
console.log("cairn-side scaffold + issue (must not echo)...");
await call("plan_scaffold_project", { name: "fidelity" });
await call("plan_scaffold_phase", { number: 1, name: "base camp" });
const mine = await call("issue_create",
  { title: "cairn-side work item", body: "created through the server — write-through should absorb it" });
const echo = await call("plan_tracker_delta", {});
check("inbound: cairn-side issue_create does not echo as external",
  !echo.__error && !(echo.new ?? []).some((i) => i.id === String(mine.id)));

// PM-side, genuinely out-of-band: new issue + title edit via gh CLI
console.log("PM-side add + edit via gh (out-of-band)...");
const pmUrl = gh("issue", "create", "--title", "PM added: reporting export",
  "--body", "Requested by the PM directly on the tracker.");
const pmId = pmUrl.split("/").pop();
gh("issue", "edit", String(mine.id), "--title", "cairn-side work item (PM retitled)");

// fresh server process per attempt (fresh 60s read cache) — the delta must see both
let peek1;
const sawBoth = await eventually(async () => {
  await c.close();
  c = await connect("fidelity-2"); call = mk(c); // fresh process = fresh 60s read cache
  peek1 = await call("plan_tracker_delta", {});
  return (peek1.new ?? []).some((i) => String(i.id) === pmId)
    && (peek1.edited ?? []).some((e) => String(e.issue.id) === String(mine.id));
});
const edited = (peek1.edited ?? []).find((e) => String(e.issue.id) === String(mine.id));
const titleChange = edited?.changes?.find((ch) => ch.field === "title");
check("inbound: PM-added issue detected as new",
  (peek1.new ?? []).some((i) => String(i.id) === pmId), `pm issue #${pmId}`);
check("inbound: PM title edit detected with from/to",
  Boolean(titleChange) && titleChange.from === "cairn-side work item"
    && titleChange.to === "cairn-side work item (PM retitled)");
void sawBoth;

// peek does not swallow: same delta re-surfaces
const peek2 = await call("plan_tracker_delta", {});
check("inbound: un-acked delta re-surfaces on the next peek",
  (peek2.new ?? []).some((i) => String(i.id) === pmId));

// declined-item path: label cairn:backlog (through the server = write-through)
await call("issue_update", { id: pmId, labels: ["cairn:backlog"] });
const backlogVisible = await eventually(async () => {
  const listed = await call("issue_list", { state: "open" });
  const arr = Array.isArray(listed) ? listed : listed.issues ?? [];
  return arr.some((i) => String(i.id) === pmId && i.labels?.includes("cairn:backlog"));
});
check("inbound: declined item labeled cairn:backlog and visible to status marks",
  backlogVisible);

// ack advances the cursor; re-run is clean
await call("plan_tracker_delta", { ack: true });
const afterAck = await call("plan_tracker_delta", {});
check("inbound: ack advances cursor — next peek clean",
  (afterAck.new ?? []).length === 0 && (afterAck.edited ?? []).length === 0);

// PM-side state change: close the PM issue out-of-band
console.log("PM-side close via gh (out-of-band)...");
gh("issue", "close", pmId);
const closeSeen = await eventually(async () => {
  await c.close();
  c = await connect("fidelity-3"); call = mk(c);
  const peek3 = await call("plan_tracker_delta", {});
  return (peek3.stateChanged ?? []).some((s) => String(s.issue.id) === pmId
    && s.from !== "closed" && s.to === "closed");
});
check("inbound: external close detected as stateChanged open→closed", closeSeen);
await call("plan_tracker_delta", { ack: true });

// =============================================================================
// OUTBOUND — paper trail on one full work issue
// =============================================================================

console.log("outbound: full work lifecycle on the cairn issue...");
const t0 = Date.now();
await call("issue_update", { id: String(mine.id), state: "in_progress" });
await call("issue_comment", { id: String(mine.id),
  text: "Starting now — phase 1 base camp, task: cairn-side work item.\n\nbase commit: " + git("rev-parse", "--short", "HEAD") });
await call("issue_comment", { id: String(mine.id),
  text: "Progress — first milestone landed, work continuing." });
writeFileSync(join(PROJECT, "work.txt"), "the work\n");
git("add", "-A"); git("commit", "-q", "-m", "feat: the work item lands");
const mins = Math.max(1, Math.round((Date.now() - t0) / 60000));
await call("issue_comment", { id: String(mine.id),
  text: "Done — the work item shipped with its change committed. Tests green.\n\ncommits: " + git("rev-parse", "--short", "HEAD") + "\ntime spent: ~" + mins + "m (approximate)" });
const closed = await call("issue_close", { id: String(mine.id), timeSpentMinutes: mins });
check("outbound: issue_close accepts timeSpentMinutes on GitHub",
  !closed.__error, JSON.stringify(closed.__error ?? "").slice(0, 80));
check("outbound: worklogLogged false on non-worklog backend (comment carries time)",
  closed.worklogLogged === false);

// verify the paper trail actually exists tracker-side, via gh (independent read)
const comments = JSON.parse(gh("issue", "view", String(mine.id), "--json", "comments"));
const bodies = comments.comments.map((x) => x.body);
check("outbound: claim comment on the tracker", bodies.some((b) => b.startsWith("Starting now")));
check("outbound: progress comment on the tracker", bodies.some((b) => b.startsWith("Progress")));
check("outbound: close comment with time line on the tracker",
  bodies.some((b) => b.includes("time spent: ~") && b.includes("(approximate)")));

// no echo from the whole outbound lifecycle (write-through covered every step)
const echo2 = await call("plan_tracker_delta", {});
check("outbound: full lifecycle produced zero external echo",
  (echo2.edited ?? []).length === 0 && (echo2.stateChanged ?? []).length === 0);

// =============================================================================
// HOOK — SessionStart staleness nudge (real hook script, stale + fresh)
// =============================================================================

console.log("hook nudge (stale vs fresh)...");
const markerPath = join(PROJECT, ".cairn", "tracker-marker.json");
const marker = JSON.parse(readFileSync(markerPath, "utf8"));
const hook = join(REPO, "hooks", "scripts", "sessionstart-continuity.mjs");
const runHook = () => {
  // the real hook resolves the project via CLAUDE_PROJECT_DIR, exactly as
  // Claude Code sets it — stdin payload is not what it reads.
  try {
    return execFileSync("node", [hook], {
      input: "{}",
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
      encoding: "utf8" });
  } catch { return ""; }
};
writeFileSync(markerPath, JSON.stringify({ ...marker, lastScan: "2026-01-01T00:00:00Z" }));
const stale = runHook();
writeFileSync(markerPath, JSON.stringify({ ...marker, lastScan: new Date().toISOString() }));
const fresh = runHook();
check("hook: stale cursor → SessionStart nudge present",
  stale.includes("tracker delta unchecked since 2026-01-01"));
check("hook: fresh cursor → no nudge", !fresh.includes("tracker delta unchecked"));

// =============================================================================
// ENGINEER MODE — config round-trip + pairing tool sequence
// =============================================================================

console.log("engineer mode: config round-trips...");
await c.close();

// mode without handle → schema rejects (CONFIG_INVALID), file semantics intact
writeConfig({ user: { mode: "engineer" } });
c = await connect("fidelity-4"); call = mk(c);
const bad = await call("config_get", {});
check("engineer: mode without handle rejected CONFIG_INVALID",
  bad.__error?.code === "CONFIG_INVALID", JSON.stringify(bad.__error ?? "").slice(0, 80));
await c.close();

// handle + mode together → loads, mode visible
writeConfig({ user: { handle: "drill-engineer", mode: "engineer" } });
c = await connect("fidelity-5"); call = mk(c);
const good = await call("config_get", {});
check("engineer: handle+mode loads, mode=engineer effective",
  good.user?.mode === "engineer" && good.user?.handle === "drill-engineer");

// human-claimed pairing tool sequence (work.md overlay): claim w/ assignee +
// scaffold claim comment, then the cairn-verified close on the human's behalf
console.log("engineer: human-claimed issue lifecycle...");
const hIssue = await call("issue_create",
  { title: "human-claimed: polish the readme", body: "Engineer takes this one." });
await call("issue_update", { id: String(hIssue.id), state: "in_progress", assignee: "drill-engineer" });
await call("issue_comment", { id: String(hIssue.id),
  text: "Claimed by drill-engineer — branch ready, task context: polish the readme. The failing check and file pointers are in the plan." });
// "human" commits out-of-band, then cairn verifies + closes on their behalf
writeFileSync(join(PROJECT, "README.md"), "# fidelity scratch\n\npolished.\n");
git("add", "-A"); git("commit", "-q", "-m", "docs: polish readme (human commit)");
await call("issue_comment", { id: String(hIssue.id),
  text: "Done — readme polished and verified. Tests green.\n\ntime spent: ~1m (approximate)\nlogged by cairn for drill-engineer" });
const hClosed = await call("issue_close", { id: String(hIssue.id), timeSpentMinutes: 1 });
const hComments = JSON.parse(gh("issue", "view", String(hIssue.id), "--json", "comments,assignees"));
check("engineer: human-claimed issue assigned + claim comment on tracker",
  hComments.comments.some((x) => x.body.startsWith("Claimed by drill-engineer")));
check("engineer: close on human's behalf says so ('logged by cairn for')",
  !hClosed.__error && hComments.comments.some((x) => x.body.includes("logged by cairn for drill-engineer")));

// vibe default: no user block → behaves exactly as before (mode undefined)
await c.close();
writeConfig();
c = await connect("fidelity-6"); call = mk(c);
const vibe = await call("config_get", {});
check("engineer: config without user.mode loads clean (vibe default)",
  !vibe.__error && vibe.user?.mode === undefined);
await c.close();

// -- summary ------------------------------------------------------------------
const fails = checks.filter(([, ok]) => !ok).length;
console.log("");
console.log("***************************");
console.log(`* fidelity drill: ${checks.length - fails}/${checks.length} ${fails ? "FAIL" : "PASS"} *`);
console.log("***************************");
process.exit(fails);
