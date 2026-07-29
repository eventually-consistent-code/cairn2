#!/usr/bin/env node

/**
 * Purpose: summarize the project's agent spend from the metrics log the Stop
 *   hook writes. Rows are cumulative per session, so totals take the LATEST
 *   row per session_id -- summing every row would multiply-count. All numbers
 *   are approximate list-price estimates.
 *
 * Usage:
 *   node cost-report.mjs              # summary: total, by phase, by issue
 *   node cost-report.mjs --issue X    # one number: est. cost for issue X
 *   node cost-report.mjs --phase N    # one number: est. cost for phase N
 *   node cost-report.mjs --json      # machine-readable summary
 * Author(s): John Reed
 */

import { readFileSync } from "node:fs";
import { metricsPath } from "./lib.mjs";

function latestPerSession(path) {
  const bySession = new Map();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      bySession.set(row.session_id, row); // later lines win -- append order
    } catch { /* skip corrupt line */ }
  }
  return [...bySession.values()];
}

function groupCost(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k === undefined || k === null) continue;
    out.set(k, (out.get(k) ?? 0) + (r.est_cost_usd ?? 0));
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const args = process.argv.slice(2);
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const rows = latestPerSession(metricsPath(projectDir));

  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const issue = flag("--issue");
  const phase = flag("--phase");
  const total = rows.reduce((s, r) => s + (r.est_cost_usd ?? 0), 0);

  if (issue !== undefined) {
    const cost = rows.filter((r) => r.issue === issue)
      .reduce((s, r) => s + (r.est_cost_usd ?? 0), 0);
    console.log(cost.toFixed(2));
    return;
  }
  if (phase !== undefined) {
    const cost = rows.filter((r) => String(r.phase) === phase)
      .reduce((s, r) => s + (r.est_cost_usd ?? 0), 0);
    console.log(cost.toFixed(2));
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      sessions: rows.length,
      total_est_usd: Number(total.toFixed(2)),
      by_phase: Object.fromEntries(groupCost(rows, "phase")),
      by_issue: Object.fromEntries(groupCost(rows, "issue")),
    }));
    return;
  }

  console.log(`agent spend (approximate, ${rows.length} sessions): $${total.toFixed(2)}`);
  const byPhase = groupCost(rows, "phase");
  if (byPhase.length) {
    console.log("by phase:");
    for (const [k, v] of byPhase.slice(0, 10)) console.log(`  phase ${k}: $${v.toFixed(2)}`);
  }
  const byIssue = groupCost(rows, "issue");
  if (byIssue.length) {
    console.log("by issue:");
    for (const [k, v] of byIssue.slice(0, 10)) console.log(`  ${k}: $${v.toFixed(2)}`);
  }
}

main();
