#!/usr/bin/env node

// Purpose: Tier C3 audit drill (mechanical) — the audit closing discipline
//          per verbs/audit.md against the REAL dist server + REAL tracker:
//          record written, two findings mirrored as cairn:audit issues
//          (severity first line, leak-clean), --fix mechanics close the
//          mechanical one with a plain-language note, the investigation-
//          shaped one opens a REAL trace (#726 leg), same-day re-run
//          supersedes the record.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  buildPatterns,
  scanLines,
} from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "audit-drill", version: "0.0.0" });
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
const today = new Date().toISOString().slice(0, 10);

// -- findings mirror as cairn:audit issues, severity first line ----------------
console.log("mirroring two findings as tracker issues...");
const mech = await call("issue_create", {
  title: "settings page still shows the old plan-name copy",
  labels: ["cairn:audit"],
  body: "important\nFound by the uat audit: the settings page header references the retired plan name. Copy fix, no behavior change.",
});
const invest = await call("issue_create", {
  title: "checkout total drifts by one cent on multi-currency carts",
  labels: ["cairn:audit"],
  body: "critical\nFound by the uat audit: totals differ between cart and confirmation on mixed-currency orders. Cause unknown — needs investigation.",
});
check(
  "mechanical finding: real cairn:audit issue",
  mech.labels?.includes("cairn:audit"),
  JSON.stringify(mech.__error ?? "").slice(0, 100),
);
check(
  "investigation finding: real cairn:audit issue",
  invest.labels?.includes("cairn:audit"),
);
check(
  "severity is the body's first line",
  mech.body?.split("\n")[0] === "important" &&
    invest.body?.split("\n")[0] === "critical",
);

// -- record written, findings carry issue ids -----------------------------------
const rec1 = await call("audit_record", {
  scope: "uat-phase-1",
  verdict: "findings",
  findings: [
    {
      severity: "important",
      title: "settings page shows old plan-name copy",
      issue: mech.id,
    },
    {
      severity: "critical",
      title: "checkout total drifts on multi-currency carts",
      issue: invest.id,
    },
    {
      severity: "minor",
      title: "empty-state illustration misaligned at narrow widths",
    },
  ],
});
check(
  "record written with three findings",
  rec1.findings === 3,
  JSON.stringify(rec1.__error ?? "").slice(0, 100),
);
const recRaw = readFileSync(
  join(PROJECT, ".cairn", "audit", `uat-phase-1-${today}.md`),
  "utf8",
);
check(
  "record: minor stays record-only, issues linked",
  recRaw.includes("## finding — minor") && recRaw.includes(`issue: ${mech.id}`),
);

// -- --fix: mechanical closes with a plain note ----------------------------------
console.log("--fix: closing the mechanical finding...");
await call("issue_comment", {
  id: mech.id,
  text: "Fixed: the settings header now uses the current plan name. One-line copy change, committed.",
});
await call("issue_close", { id: mech.id });
check(
  "mechanical finding closed",
  (await call("issue_get", { id: mech.id })).state === "closed",
);

// -- --fix: investigation-shaped opens a REAL trace (#726 leg) --------------------
console.log("--fix: routing the investigation finding into trace...");
const trace = await call("trace_start", {
  description: "audit finding: checkout total drifts on multi-currency carts",
  issueId: invest.id,
});
check(
  "trace opened on the finding's issue — no inline fix",
  Boolean(trace.id) && trace.issue === invest.id,
);
await call("trace_log", {
  id: trace.id,
  kind: "evidence",
  text: "Reproduced from the audit: EUR+USD cart shows 84.31 in cart, 84.32 at confirmation.",
});
const landscape = await call("session_landscape", {});
check(
  "trace visible in the landscape",
  landscape.sessions?.some((s) => s.id === trace.id && s.status === "open"),
);

// -- same-day supersede -----------------------------------------------------------
const rec2 = await call("audit_record", {
  scope: "uat-phase-1",
  verdict: "findings",
  findings: [
    {
      severity: "critical",
      title: "checkout total drifts on multi-currency carts",
      issue: invest.id,
    },
  ],
});
const recRaw2 = readFileSync(rec2.path, "utf8");
check(
  "same-day re-run supersedes the record",
  rec2.findings === 1 && !recRaw2.includes("plan-name copy"),
);

// -- leak scan over everything sent to the tracker ---------------------------------
const sent = [
  mech.body,
  invest.body,
  "Fixed: the settings header now uses the current plan name. One-line copy change, committed.",
];
const hits = scanLines(
  sent.flatMap((t) => t.split("\n")),
  buildPatterns(null),
);
check(
  "leak scan: zero pattern hits in tracker text",
  hits.length === 0,
  hits.map((h) => h.name).join(","),
);

// cleanup: close the trace + investigation issue so the scratch repo ends tidy
await call("trace_log", {
  id: trace.id,
  kind: "verdict",
  text: "Cause: per-currency rounding applied twice. Fix: round once at total. Commit: fed9876.",
});
await call("trace_close", {
  id: trace.id,
  resolution:
    "Rounding now happens once at the total, so cart and confirmation agree to the cent.",
});

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
