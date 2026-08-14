#!/usr/bin/env node

// Purpose: Tier B distill drill (mechanical) — verbs/distill.md's sanitize
//          gate proven end-to-end: generate docs from real plan artifacts,
//          FIRST DRAFT deliberately carrying internal refs, prove the
//          leak-patterns CLI catches them (exit 1), rewrite public-safe,
//          prove the re-scan gate passes (exit 0), write to docs/, and
//          assert ADRs trace to locked decisions via commit shas only.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);
const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "scripts",
  "leak-patterns.mjs",
);

const git = (...args) =>
  execFileSync("git", args, { cwd: PROJECT, encoding: "utf8" }).trim();
const scan = (...files) =>
  spawnSync("node", [CLI, ...files], { cwd: PROJECT, encoding: "utf8" });

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "distill-drill", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

// -- setup: shipped phase with a locked decision -----------------------------
console.log("building a shipped phase with a locked decision...");
await call("plan_scaffold_project", { name: "distill drill" });
const phase = await call("plan_scaffold_phase", {
  number: 1,
  name: "memory index",
});
const ctxPath = join(PROJECT, ".cairn/plans/phases", phase.dir, "CONTEXT.md");
writeFileSync(
  ctxPath,
  `# Phase 1: memory index — Context

## Locked decisions

- Use SQLite FTS5 for the memory index — porter stemming, contentless tables.
`,
);
git("add", "-A");
git("commit", "-m", "chore: scaffold + lock decision", "--no-gpg-sign");
const decisionSha = git("rev-parse", "HEAD");
await call("ledger_append", {
  phaseDir: phase.dir,
  taskRef: "D1",
  summary: "FTS5 memory index shipped",
  baseCommit: decisionSha,
  headCommit: decisionSha,
  issueId: "DRILL-77",
  closedDate: new Date().toISOString().slice(0, 10),
});
await client.close();

// -- draft docs WITH internal refs (what a naive distill would emit) ----------
const tmp = join(PROJECT, ".distill-tmp");
mkdirSync(tmp, { recursive: true });
const draftAdr = join(tmp, "0001-use-sqlite-fts5.md");
writeFileSync(
  draftAdr,
  `# ADR 0001: Use SQLite FTS5 for the memory index

## Context
Decided in phases/01-memory-index (see .cairn/plans/phases/01-memory-index/CONTEXT.md), tracked as DRILL-77.

## Decision
SQLite FTS5 with porter stemming and contentless tables.
`,
);
const draftScan = scan(draftAdr);
check(
  "sanitize gate catches draft internal refs (exit 1)",
  draftScan.status === 1 &&
    /phase-ref/.test(draftScan.stdout) &&
    /cairn-path/.test(draftScan.stdout) &&
    /tracker-id/.test(draftScan.stdout),
  draftScan.stdout.split("\n")[0] ?? "",
);

// -- rewrite public-safe, re-scan until clean ---------------------------------
writeFileSync(
  draftAdr,
  `# ADR 0001: Use SQLite FTS5 for the memory index

## Context
Decided during the memory-index milestone work (commit ${decisionSha.slice(0, 7)}); the index needed full-text search without a service dependency.

## Decision
SQLite FTS5 with porter stemming and contentless tables.

## Consequences
Search stays local and rebuildable; the index is disposable state.
`,
);
const rescan = scan(draftAdr);
check(
  "re-scan clean (exit 0) — the gate",
  rescan.status === 0,
  rescan.stdout.trim(),
);

// -- write final docs/ set + CHANGELOG from ledger ----------------------------
mkdirSync(join(PROJECT, "docs", "adr"), { recursive: true });
const finalAdr = join(PROJECT, "docs", "adr", "0001-use-sqlite-fts5.md");
writeFileSync(finalAdr, readFileSync(draftAdr, "utf8"));
const ledgerLine =
  readFileSync(
    join(PROJECT, ".cairn/plans/phases", phase.dir, "LEDGER.md"),
    "utf8",
  )
    .split("\n")
    .find((l) => l.startsWith("- [x]")) ?? "";
const summary = ledgerLine.split(" — ")[1] ?? "work shipped";
writeFileSync(
  join(PROJECT, "docs", "CHANGELOG.md"),
  `# Changelog\n\n## Milestone 1\n\n- ${summary} (${decisionSha.slice(0, 7)})\n`,
);
writeFileSync(
  join(PROJECT, "docs", "ARCHITECTURE.md"),
  `# Architecture\n\n## Memory index\n\nFull-text search is SQLite FTS5 (porter stemming, contentless tables) — local, rebuildable, no service dependency. Decided at ${decisionSha.slice(0, 7)}.\n`,
);

// -- final assertions ----------------------------------------------------------
const finals = [
  "docs/adr/0001-use-sqlite-fts5.md",
  "docs/CHANGELOG.md",
  "docs/ARCHITECTURE.md",
].map((f) => join(PROJECT, f));
const finalScan = scan(...finals);
check(
  "zero leak-pattern hits across ALL final docs (mechanically scanned)",
  finalScan.status === 0,
  finalScan.stdout.trim(),
);
const adrText = readFileSync(finalAdr, "utf8");
check(
  "ADR traces to the locked decision via commit sha",
  adrText.includes(decisionSha.slice(0, 7)) && adrText.includes("SQLite FTS5"),
);
check(
  "ADR carries no phase dirs, no .cairn, no tracker ids",
  !/phases\/\d{2}|\.cairn\/|DRILL-\d+/.test(adrText),
);
const changelog = readFileSync(join(PROJECT, "docs", "CHANGELOG.md"), "utf8");
check(
  "CHANGELOG entry derived from the real ledger summary",
  changelog.includes("FTS5 memory index shipped"),
);

const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
