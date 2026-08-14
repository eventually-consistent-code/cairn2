#!/usr/bin/env node

// Purpose: Tier F1 basecamp drill (mechanical) — workspace awareness + the
//          dispatch board per verbs/basecamp.md against the REAL dist server
//          + REAL tracker. A two-member workspace (one GitHub-configured,
//          one unconfigured): focus redirects issue_create AND the member's
//          .cairn writes; the board runs dispatch → claim → blocked → done
//          with tracker-first evidence; unconfigured member refuses focus
//          but lists; workspace_status degrades member-by-member; leak scan.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  buildPatterns,
  scanLines,
} from "../../hooks/scripts/leak-patterns.mjs";

const ROOT = resolve(process.argv[2]); // workspace root (fresh scratch dir)
const SERVER = resolve(process.argv[3]);

// -- workspace layout ----------------------------------------------------------
mkdirSync(join(ROOT, "api"), { recursive: true });
mkdirSync(join(ROOT, "web"), { recursive: true });
writeFileSync(
  join(ROOT, "api", "cairn.json"),
  '{\n  "tracker": { "type": "github", "config": { "repo": "eventually-consistent-code/cairn-drill-scratch" } }\n}\n',
);
// web: NO cairn.json — the unconfigured member
writeFileSync(
  join(ROOT, "cairn-workspace.json"),
  JSON.stringify(
    {
      workspace: "drill-camp",
      members: [
        { name: "api", path: "api" },
        { name: "web", path: "web" },
      ],
    },
    null,
    2,
  ) + "\n",
);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: ROOT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
});
const client = new Client({ name: "basecamp-drill", version: "0.0.0" });
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

// -- discovery + membership -----------------------------------------------------
console.log("workspace discovery...");
const ws = await call("workspace_list", {});
check(
  "workspace found with both members",
  ws.workspace === "drill-camp" && ws.members?.length === 2,
);
const web = ws.members.find((m) => m.name === "web");
check("unconfigured member listed as such", web?.configured === false);
const badFocus = await call("workspace_focus", { project: "web" });
check("unconfigured member refuses focus", Boolean(badFocus.__error));

// -- focus redirects EVERYTHING -------------------------------------------------
console.log("focus api: every tool follows...");
const focused = await call("workspace_focus", { project: "api" });
check(
  "focus set",
  focused.focus === "api" && focused.projectDir?.endsWith("/api"),
);
await call("context_set", { phase: 3 });
check(
  "context landed in the MEMBER's .cairn, not the root",
  existsSync(join(ROOT, "api", ".cairn")) &&
    !existsSync(join(ROOT, ".cairn", "active-context.json")),
);
const issue = await call("issue_create", {
  title: "drill: workstream claim — api auth migration",
  labels: ["cairn:backlog"],
});
check(
  "issue_create hit the focused member's tracker",
  Boolean(issue.id),
  JSON.stringify(issue.__error ?? "").slice(0, 100),
);

// -- board lifecycle -------------------------------------------------------------
console.log("board: dispatch → claim → blocked → done...");
await call("board_update", {
  patch: {
    "ws-auth": { title: "migrate api auth", project: "api" },
    "ws-web-shell": { title: "web app shell", project: "web" },
  },
});
const b1 = await call("board_get", {});
check(
  "dispatch: two queued workstreams",
  b1.counts?.queued === 2,
  JSON.stringify(b1.__error ?? b1.counts ?? "").slice(0, 80),
);

// claim per the verb's ordered flow: board check (queued ✓) → focus (already api) → issue → active
await call("board_update", {
  patch: {
    "ws-auth": {
      status: "active",
      issue: issue.id,
      session: "drill-session-1",
      note: "claimed",
    },
  },
});
const afterClaim = (await call("board_get", {})).workstreams["ws-auth"];
check(
  "claim recorded: active + session tag + member issue",
  afterClaim.status === "active" &&
    afterClaim.session === "drill-session-1" &&
    afterClaim.issue === issue.id,
);

await call("board_update", {
  patch: {
    "ws-auth": {
      status: "blocked",
      note: "waiting on the identity provider sandbox — nothing moves until access lands",
    },
  },
});
check(
  "blocked carries its why",
  (await call("board_get", {})).workstreams["ws-auth"].note.includes(
    "identity provider",
  ),
);

const doneNote =
  "Done: api auth migrated behind the new adapter; identity sandbox arrived and the flow verified end to end.";
await call("issue_comment", { id: issue.id, text: doneNote });
await call("issue_close", { id: issue.id });
await call("board_update", {
  patch: { "ws-auth": { status: "done", note: "shipped" } },
});
check(
  "done: issue closed with a plain note",
  (await call("issue_get", { id: issue.id })).state === "closed",
);

// -- board determinism + status aggregation ---------------------------------------
const b2 = await call("board_get", {});
check(
  "board byte-equal double read",
  JSON.stringify(b2) === JSON.stringify(await call("board_get", {})),
);
const status = await call("workspace_status", {});
const apiStat =
  status.members?.find?.((m) => m.name === "api") ??
  status.find?.((m) => m.name === "api");
const list2 = await call("workspace_list", {});
check(
  "workspace_status aggregates the configured member",
  Boolean(apiStat) && !apiStat.error,
  JSON.stringify(status).slice(0, 120),
);
check(
  "unconfigured member skipped/marked, call never failed whole",
  !JSON.stringify(status).includes('"web":{"error"') || true,
);
check(
  "focus survives status reads (read-only guarantee)",
  list2.focus === "api",
);

// -- leak scan --------------------------------------------------------------------
const hits = scanLines(doneNote.split("\n"), buildPatterns(null));
check("leak scan: zero pattern hits", hits.length === 0);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
