#!/usr/bin/env node

// Purpose: Tier B mark drill (mechanical) — the three capture kinds per
//          verbs/mark.md against the REAL dist server + REAL tracker.
//          Pass condition: each kind is exactly ONE tool call, no questions
//          (mechanically: no interview step exists in this flow), backlog/
//          seed land bare on the tracker, note card is recallable.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "mark-drill", version: "0.0.0" });
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

// -- backlog: ONE call ------------------------------------------------------
console.log("mark (backlog): one issue_create call...");
const backlog = await call("issue_create", {
  title: "flaky retry test needs a deadline, not a count",
  labels: ["cairn:backlog"],
});
check(
  "backlog: one call → real issue",
  Boolean(backlog.id),
  JSON.stringify(backlog.__error ?? "").slice(0, 100),
);
check(
  "backlog: bare — label only, no body",
  backlog.labels?.includes("cairn:backlog") && (backlog.body ?? "") === "",
);
check("backlog: open on tracker", backlog.state === "open");

// -- seed: ONE call ---------------------------------------------------------
console.log("mark (--seed): one issue_create call...");
const seed = await call("issue_create", {
  title: "swap polling for webhooks",
  labels: ["cairn:seed"],
  body: "Trigger: when the tracker adapter gains webhook support",
});
check(
  "seed: one call → real issue with trigger body",
  Boolean(seed.id) &&
    seed.labels?.includes("cairn:seed") &&
    /^Trigger: /.test(seed.body ?? ""),
);

// -- note: ONE call (scoped from active context) ----------------------------
console.log("mark (--note): context_set then one mem_card_create call...");
await call("context_set", { phase: 1 });
const note = await call("mem_card_create", {
  type: "note",
  body: "the drill tracker rate-limits around 80 rapid issue creates",
  scopePhase: 1,
});
check("note: one call → note card", note.id?.startsWith("note-") === true);

// recallable
const listed = await call("mem_card_list", { scopePhase: 1 });
check(
  "note: recallable via mem_card_list (scoped)",
  Array.isArray(listed) && listed.some((c) => c.id === note.id),
);
const recalled = await call("mem_card_recall", { scopePhase: 1 });
check(
  "note: mem_card_recall returns it",
  Array.isArray(recalled) &&
    recalled.some((c) => (c.card?.id ?? c.id) === note.id),
);

// tracker read-back: both marks visible, bare
const back = await call("issue_get", { id: backlog.id });
check(
  "tracker read-back: backlog mark intact",
  back.labels?.includes("cairn:backlog"),
);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
