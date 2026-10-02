#!/usr/bin/env node

// Eval verdicts (issue #209). The `claude plugin eval` harness scores a
// case as one mean over its runs; this post-processor reads the same
// aggregate-result.json and says what the runs mean for a stochastic
// subject: PASS, FAIL, or INCONCLUSIVE.
//
// Two tiers, read from each case's frontmatter `tags:` (exactly one of):
//   regression — must pass ALL runs (pass^k). A gate row.
//   capability — allowed to fail; an improvement target, never a gate.
// Mixing the two in one number produces wrong priorities (docs/EVALS.md).
//
// Per case: runs/passed from arms.with[] (passed = runs with passed true);
//   verdict PASS (all) / FAIL (none) / INCONCLUSIVE (split — add runs);
//   gate = tier === 'regression'; gateOk = !gate || verdict === 'PASS'.
//
// Usage:
//   node scripts/eval-verdicts.mjs <results-dir | aggregate-result.json> [--json]
//   A directory means its aggregate-result.json, or — for a parent like
//   evals/results — the newest timestamped subdir that holds one.
//
// --json prints { source, cases: [{ case, tier, runs, passed, verdict,
//   gate, gateOk }], gateOk }. That shape is a contract: other tooling
//   reads it.
//
// Exit 0 every gate ok; 1 a regression gate not ok; 2 load error / no cases.
//
// Author(s): John Reed

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";


// Constants

const AGGREGATE = "aggregate-result.json";
const TIERS = ["regression", "capability"];


/** A load problem — always exit 2, never a verdict. */
class LoadError extends Error {}


/**
 * Resolve the CLI argument to an aggregate-result.json path.
 * :param arg  file or directory path
 * :returns absolute path of the aggregate file
 */
function resolveSource(arg) {
  const p = resolve(arg);
  if (!existsSync(p)) throw new LoadError(`no such file or directory: ${arg}`);
  if (statSync(p).isFile()) return p;

  // A results dir for one run
  const direct = join(p, AGGREGATE);
  if (existsSync(direct)) return direct;

  // A parent of timestamped run dirs — pick the newest one that has results
  const runs = readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(p, d.name, AGGREGATE)))
    .map((d) => d.name);
  if (runs.length === 0) throw new LoadError(`no ${AGGREGATE} in ${arg} or any subdirectory`);
  const stamped = runs.filter((n) => /^\d/.test(n)).sort();
  const newest = stamped.length > 0
    ? stamped[stamped.length - 1]
    : runs.sort((a, b) => statSync(join(p, a)).mtimeMs - statSync(join(p, b)).mtimeMs).pop();
  return join(p, newest, AGGREGATE);
}


/**
 * Pull the `tags:` list out of a prompt's YAML frontmatter.
 * Handles the flow form (`tags: [a, b]`) and the block form (`- a`).
 * :param md  the case's promptMarkdown
 * :returns array of tag strings (empty if none)
 */
function frontmatterTags(md) {
  if (typeof md !== "string") return [];
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^tags\s*:/.test(l));
  if (i < 0) return [];
  const rest = lines[i].replace(/^tags\s*:\s*/, "").trim();
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
  if (rest.startsWith("[")) {
    return rest.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  }
  if (rest) return [unquote(rest)];
  const tags = [];
  for (const l of lines.slice(i + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(l);
    if (!item) break;
    tags.push(unquote(item[1]));
  }
  return tags;
}


/**
 * Turn one aggregate case into its verdict row.
 * :param c  a cases[] entry from aggregate-result.json
 * :param idx  its position (names a case that carries no name)
 * :returns { case, tier, runs, passed, verdict, gate, gateOk }
 */
function verdictFor(c, idx) {
  const name = c?.name ?? c?.case ?? c?.id ?? `cases[${idx}]`;
  const tags = frontmatterTags(c?.promptMarkdown);
  const tiers = TIERS.filter((t) => tags.includes(t));
  if (tiers.length !== 1) {
    throw new LoadError(
      `case '${name}' must carry exactly one of tags ${TIERS.join(" / ")} (found ${tiers.length === 0 ? "none" : tiers.join(" + ")})`,
    );
  }
  const tier = tiers[0];
  const withArm = Array.isArray(c?.arms?.with) ? c.arms.with : [];
  const runs = withArm.length;
  const passed = withArm.filter((r) => r?.passed === true).length;
  if (runs === 0) throw new LoadError(`case '${name}' has no with-plugin runs`);

  // pass^k: a split is not a fractional score, it is "we don't know yet"
  const verdict = passed === runs ? "PASS" : passed === 0 ? "FAIL" : "INCONCLUSIVE";
  const gate = tier === "regression";
  const gateOk = !gate || verdict === "PASS";
  return { case: name, tier, runs, passed, verdict, gate, gateOk };
}


/**
 * Load the aggregate file and compute every verdict.
 * :param arg  CLI path argument
 * :returns { source, cases, gateOk }
 */
function evaluate(arg) {
  const source = resolveSource(arg);
  let doc;
  try {
    doc = JSON.parse(readFileSync(source, "utf8"));
  } catch (err) {
    throw new LoadError(`cannot parse ${source}: ${err.message}`);
  }
  const raw = Array.isArray(doc?.cases) ? doc.cases : [];
  if (raw.length === 0) throw new LoadError(`no cases in ${source}`);
  const cases = raw.map(verdictFor);
  return { source, cases, gateOk: cases.every((c) => c.gateOk) };
}


/**
 * Render the human table plus a one-line summary.
 * :param result  output of evaluate()
 * :returns string
 */
function table(result) {
  const head = ["case", "tier", "passed", "verdict", "gate"];
  const rows = result.cases.map((c) => [
    c.case,
    c.tier,
    `${c.passed}/${c.runs}`,
    c.verdict,
    c.gate ? (c.gateOk ? "ok" : "BLOCK") : "-",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  const count = (v) => result.cases.filter((c) => c.verdict === v).length;
  const regs = result.cases.filter((c) => c.gate);
  const bad = regs.filter((c) => !c.gateOk).length;
  const summary =
    `${result.cases.length} cases: ${count("PASS")} pass, ${count("FAIL")} fail, ${count("INCONCLUSIVE")} inconclusive — ` +
    `regression gate ${bad === 0 ? "ok" : `NOT ok (${bad}/${regs.length} regression cases not PASS)`}`;
  return [`source: ${result.source}`, fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt), "", summary].join("\n");
}


// Main

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const paths = args.filter((a) => a !== "--json");
  if (paths.length !== 1) {
    process.stderr.write("usage: node scripts/eval-verdicts.mjs <results-dir | aggregate-result.json> [--json]\n");
    process.exit(2);
  }

  let result;
  try {
    result = evaluate(paths[0]);
  } catch (err) {
    if (!(err instanceof LoadError)) throw err;
    process.stderr.write(`eval-verdicts: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write((json ? JSON.stringify(result, null, 2) : table(result)) + "\n");
  process.exit(result.gateOk ? 0 : 1);
}

main();
