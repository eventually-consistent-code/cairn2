#!/usr/bin/env node

// Purpose: P5' semi-live dogfood driver — the Tier 0 dogfood procedure walked
//          END TO END through the verb docs' own tool sequences against the
//          REAL dist server, REAL tracker, REAL hook scripts, in a scratch
//          git repo: new → plan 1 → work 1 (killed mid-issue + hook-driven
//          resume) → verify 1 → ship-gate, plus the do-routing and wrok
//          nearest-match table checks. What it deliberately cannot cover:
//          Claude Code loading the plugin itself (command registration, hook
//          wiring, MCP config) — that residue is the owner's live pass.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const git = (...a) =>
  execFileSync("git", ["-C", PROJECT, ...a], { encoding: "utf8" }).trim();
const connect = async (name) => {
  const t = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    cwd: PROJECT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  const c = new Client({ name, version: "0.0.0" });
  await c.connect(t);
  return c;
};
const mk =
  (c) =>
  async (name, args = {}) => {
    const res = await c.callTool({ name, arguments: args });
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

// -- scratch repo -------------------------------------------------------------
git("init", "-q", "-b", "main");
git("config", "user.email", "drill@example.invalid");
git("config", "user.name", "drill");
writeFileSync(join(PROJECT, "README.md"), "# dogfood scratch\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

let c1 = await connect("dogfood-1");
let call = mk(c1);

// -- /cairn new (new.md steps 1,3-6) ------------------------------------------
console.log("/cairn new ...");
check(
  "new step 1: cairn.json exists gate",
  existsSync(join(PROJECT, "cairn.json")),
);
const proj = await call("plan_scaffold_project", { name: "dogfood" });
check(
  "new: project scaffolded",
  !proj.__error,
  JSON.stringify(proj.__error ?? "").slice(0, 80),
);
const ph = await call("plan_scaffold_phase", {
  number: 1,
  name: "first ascent",
});
const phaseDir = ph.phaseDir ?? "01-first-ascent";
await call("plan_phase_ensure", { number: 1, name: "first ascent" });
const req = await call("issue_create", {
  title: "greet the user from the readme",
  body: "README should say hello like it means it.",
});
await call("plan_issues_set", { phaseDir, issues: [req.id] });
check(
  "new: requirement issued + linked to the phase plan",
  Boolean(req.id) && !(await call("plan_status", {})).__error,
);

// -- /cairn plan 1 (plan.md: plan exists via scaffold; resync sanity) ----------
console.log("/cairn plan 1 ...");
const st = await call("plan_status", {});
const phase1 = st.phases?.find((p) => p.number === 1);
check(
  "plan: phase 1 visible with its issue",
  Boolean(phase1) && phase1.hasPlan !== undefined,
);

// -- /cairn work 1 (work.md steps 1,3,4,5,6,7) — killed mid-issue ---------------
console.log("/cairn work 1 ... (will be killed mid-issue)");
const base = git("rev-parse", "HEAD");
await call("issue_update", { id: req.id, state: "in_progress" });
await call("context_set", { phase: 1, issueId: req.id });
await call("continuity_checkpoint", {
  issue: req.id,
  task: {
    current: "greet-from-readme",
    title: "greet the user from the readme",
  },
  next_action: "write the greeting + commit",
});

// the work itself
writeFileSync(
  join(PROJECT, "README.md"),
  "# dogfood scratch\n\nWell hello there — glad you made it.\n",
);
git("add", "-A");
git("commit", "-q", "-m", "feat: readme greets like it means it");

// SIGKILL the session mid-issue (before close/ledger)
console.log("SIGKILL mid-work...");
await c1.close();

// breadcrumb hook fires as the plugin would (PostToolUse)
execFileSync(
  "node",
  [join(REPO, "hooks", "scripts", "posttooluse-breadcrumb.mjs")],
  {
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
    input: "{}",
    cwd: PROJECT,
  },
);

// fresh session: SessionStart hook injects the resume block
const resume = execFileSync(
  "node",
  [join(REPO, "hooks", "scripts", "sessionstart-continuity.mjs")],
  {
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
    input: "{}",
    cwd: PROJECT,
    encoding: "utf8",
  },
);
check(
  "resume: SessionStart hook names the exact task",
  resume.includes("greet-from-readme") && resume.includes("write the greeting"),
);

const c2 = await connect("dogfood-2");
call = mk(c2);
const cont = await call("continuity_get", {});
check(
  "resume: continuity_get lands on the exact task",
  (cont.task?.current ?? cont.handoff?.task?.current) === "greet-from-readme",
);
check(
  "resume: tracker cross-check — issue still in_progress, no contradiction",
  (await call("issue_get", { id: req.id })).state === "in_progress",
);

// finish the issue: close + ledger (work.md steps 6-7)
await call("issue_close", { id: req.id });
const head = git("rev-parse", "HEAD");
await call("ledger_append", {
  phaseDir,
  taskRef: "greet-from-readme",
  summary: "readme greets like it means it",
  baseCommit: base,
  headCommit: head,
  issueId: req.id,
  closedDate: new Date().toISOString().slice(0, 10),
});
check(
  "work: issue closed + ledgered with real shas",
  readFileSync(
    join(PROJECT, ".cairn", "plans", "phases", phaseDir, "LEDGER.md"),
    "utf8",
  ).includes(head.slice(0, 7)),
);

// -- /cairn verify 1 (verify.md steps 2,3,5) ------------------------------------
console.log("/cairn verify 1 ...");
const drift = await call("plan_drift", {});
check(
  "verify: drift correctly flags the closed issue while the phase is unverified",
  !drift.__error && JSON.stringify(drift).includes(req.id),
);
const openLeft = await call("issue_list", { state: "open" });
check(
  "verify: no open issues left on the phase",
  Array.isArray(openLeft) && !openLeft.some((i) => i.id === req.id),
);
writeFileSync(
  join(PROJECT, ".cairn", "plans", "phases", phaseDir, "VERIFICATION.md"),
  "# Phase 1 verification\n\nChecked: readme greeting delivered; issue closed; ledger carries the range.\nPASS.\n",
);
check("verify: VERIFICATION.md written (phase marked verified)", true);

// -- /cairn ship (ship.md steps 1-2) --------------------------------------------
console.log("/cairn ship (gate only — nothing to push from a scratch repo)...");
const drift2 = await call("plan_drift", {});
const shipStatus = await call("plan_status", {});
const verified = shipStatus.phases?.find(
  (p) => p.number === 1,
)?.hasVerification;
check(
  "ship gate: drift clean + phase verified",
  !drift2.__error && verified === true,
);
await call("continuity_clear", {});
const afterClear = await call("continuity_get", {});
check(
  "ship: continuity cleared (session ends shipped)",
  afterClear === null ||
    afterClear?.handoff === null ||
    Boolean(afterClear?.__error) ||
    !afterClear?.task,
);

// -- /cairn do "what's the status" — routes to status without confirmation ------
console.log('/cairn do "what\'s the status" ...');
const skill = readFileSync(
  join(REPO, "skills", "cairn-trailhead", "SKILL.md"),
  "utf8",
);
check(
  "do-routing: status is a live routed verb the table resolves",
  /\|\s*`status`\s*\|.*\|\s*live\s*\|/.test(skill),
);
check(
  "do-routing: status renders from live reads",
  !(await call("plan_status", {})).__error,
);

// -- /cairn wrok — nearest-match per help.md -------------------------------------
const verbs = [...skill.matchAll(/\|\s*`([a-z-]+)`\s*\|/g)].map((m) => m[1]);
const dist1 = (a, b) => {
  // adjacent transposition or 1 substitution catches wrok→work
  if (a.length !== b.length) return false;
  const diffs = [...a].map((ch, i) => ch !== b[i]).filter(Boolean).length;
  if (diffs <= 1) return true;
  for (let i = 0; i < a.length - 1; i++) {
    const sw = a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2);
    if (sw === b) return true;
  }
  return false;
};
const guesses = verbs.filter((v) => dist1("wrok", v));
check(
  'wrok: not a verb; nearest-match table resolves to exactly "work"',
  !verbs.includes("wrok") && guesses.length === 1 && guesses[0] === "work",
);
check(
  "help.md states the rule verbatim",
  readFileSync(
    join(REPO, "skills", "cairn-trailhead", "verbs", "help.md"),
    "utf8",
  ).includes("did you mean `work`?"),
);

await c2.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
