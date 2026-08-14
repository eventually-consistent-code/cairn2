#!/usr/bin/env node

// Purpose: Tier B leak drill (mechanical) — the pretooluse-leakguard hook
//          spawned exactly as the plugin fires it, against a real git repo
//          with a jira-configured cairn.json (DRILL-N tracker-id pattern
//          needs no live Jira — it's config-derived). Exercises: block with
//          path:line listing, clean pass, prefix override, quoted-mention
//          still blocks, tune-off disable (via the REAL config_set tool),
//          and the review-hardened -am widened scan.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);
const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "scripts",
  "pretooluse-leakguard.mjs",
);

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

const git = (...args) =>
  execFileSync("git", args, { cwd: PROJECT, encoding: "utf8" }).trim();
const hook = (command) =>
  spawnSync("node", [HOOK], {
    cwd: PROJECT,
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: PROJECT,
    }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });

// -- case 1: staged leak blocks with path:line listing ----------------------
writeFileSync(
  join(PROJECT, "app.ts"),
  'const planPath = ".cairn/plans/roadmap.md"; // tracked as DRILL-42\n',
);
git("add", "app.ts");
let r = hook("git commit -m 'add app'");
check("staged leak → exit 2", r.status === 2);
check(
  "listing has path:line + both patterns",
  /app\.ts:1: \[cairn-path\]/.test(r.stderr) &&
    /app\.ts:1: \[tracker-id\] DRILL-42/.test(r.stderr),
  r.stderr.split("\n")[1] ?? "",
);

// -- case 2: fixed file passes ----------------------------------------------
writeFileSync(
  join(PROJECT, "app.ts"),
  "const planPath = process.env.PLAN_PATH;\n",
);
git("add", "app.ts");
r = hook("git commit -m 'add app'");
check("fixed staging → exit 0", r.status === 0);

// -- case 3: prefix override -------------------------------------------------
writeFileSync(join(PROJECT, "app.ts"), 'const p = ".cairn/x"; // DRILL-7\n');
git("add", "app.ts");
r = hook("CAIRN_LEAK_OK=1 git commit -m 'override once'");
check("CAIRN_LEAK_OK=1 prefix → exit 0", r.status === 0);

// -- case 4: quoted mention does NOT bypass ----------------------------------
r = hook("git commit -m 'docs: explain the CAIRN_LEAK_OK=1 override'");
check("quoted mention still blocks → exit 2", r.status === 2);

// -- case 5: -am widened scan catches UNSTAGED tracked leak ------------------
// re-stage clean content over case 3/4's staged leak, land it, THEN leak unstaged
writeFileSync(join(PROJECT, "app.ts"), "const clean = true;\n");
git("add", "app.ts");
git("commit", "-m", "app clean", "--no-gpg-sign");
writeFileSync(
  join(PROJECT, "app.ts"),
  'const leak = ".cairn/handoff"; // DRILL-9\n',
); // tracked, NOT staged
r = hook("git commit -am 'sweep everything'");
check(
  "-am widened scan catches unstaged tracked leak → exit 2",
  r.status === 2,
);
r = hook("git commit -m 'narrow commit'");
check("plain commit with nothing staged → exit 0", r.status === 0);

// -- case 6: tune front door disables (REAL config_set tool) -----------------
console.log("disabling via config_set (tune's mechanism)...");
const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "leak-drill", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};
const cfg = await call("config_set", {
  patch: { leakGuard: { enabled: false } },
});
check(
  "config_set flips leakGuard.enabled false",
  cfg.leakGuard?.enabled === false,
);
git("add", "app.ts"); // the leaky version, staged
r = hook("git commit -m 'guard off'");
check("guard disabled → exit 0 despite staged leak", r.status === 0);
await call("config_set", { patch: { leakGuard: { enabled: true } } });
await client.close();

const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
