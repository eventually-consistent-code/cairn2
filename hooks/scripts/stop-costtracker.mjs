#!/usr/bin/env node

/**
 * Purpose: Stop hook -- when Claude finishes responding, parse the session
 *   transcript's usage entries and append one cumulative cost snapshot to
 *   ~/.cairn/metrics/<project>.jsonl, tagged with the active cairn phase and
 *   issue so spend rolls up to the work items the tracker shows. Rows are
 *   cumulative per session: reports take the LATEST row per session_id.
 *   Fire-and-forget and throttled -- a hook must never be visible or block.
 * Author(s): John Reed
 */

import { readFileSync, statSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { metricsPath } from "./lib.mjs";

const THROTTLE_MS = 30_000;
const MAX_LINES = 5000;
const KEEP_LINES = 2500;

// $ per MTok, approximate list prices. Cache write ~1.25x input, read ~0.1x.
// Unknown models price as sonnet -- the report labels everything approximate.
const PRICES = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /haiku/i, in: 0.8, out: 4 },
  { match: /sonnet|fable|mythos/i, in: 3, out: 15 },
];

function priceFor(model) {
  return PRICES.find((p) => p.match.test(model ?? "")) ?? PRICES[2];
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** Sum usage across the transcript's assistant entries, per model. */
function sumUsage(transcriptPath) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set() };
  const raw = readFileSync(transcriptPath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (!usage || entry?.type !== "assistant") continue;
    const model = entry.message.model ?? "unknown";
    const p = priceFor(model);
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    const cacheW = usage.cache_creation_input_tokens ?? 0;
    const cacheR = usage.cache_read_input_tokens ?? 0;
    totals.input += inTok;
    totals.output += outTok;
    totals.cacheWrite += cacheW;
    totals.cacheRead += cacheR;
    totals.cost += (inTok * p.in + outTok * p.out + cacheW * p.in * 1.25 + cacheR * p.in * 0.1) / 1e6;
    totals.models.add(model);
  }
  return totals;
}

/** Active cairn phase/issue, if the project has them set. */
function activeContext(projectDir) {
  try {
    const s = JSON.parse(readFileSync(join(projectDir, ".cairn", "state", "active-context.json"), "utf8"));
    return { phase: s.phase, issue: s.issueId };
  } catch {
    return {};
  }
}

/** Retention guard -- the metrics log must not grow unbounded (CRN-27). */
function capFile(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length <= MAX_LINES) return;
  writeFileSync(path, lines.slice(-KEEP_LINES).join("\n") + "\n");
}

function main() {
  const payload = readStdin();
  if (!payload?.transcript_path || !payload.session_id) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const path = metricsPath(projectDir);

  try {
    if (Date.now() - statSync(path).mtimeMs < THROTTLE_MS) return; // throttled
  } catch { /* no file yet -- first write proceeds */ }

  const totals = sumUsage(payload.transcript_path);
  if (totals.input + totals.output === 0) return;

  const row = {
    ts: new Date().toISOString(),
    session_id: payload.session_id,
    ...activeContext(projectDir),
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_write_tokens: totals.cacheWrite,
    cache_read_tokens: totals.cacheRead,
    est_cost_usd: Number(totals.cost.toFixed(4)),
    models: [...totals.models],
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
  capFile(path);
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
