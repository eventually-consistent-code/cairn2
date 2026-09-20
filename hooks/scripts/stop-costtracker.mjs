#!/usr/bin/env node

/**
 * Purpose: Stop hook -- when Claude finishes responding, parse the session
 *   transcript's usage entries and append one cumulative cost snapshot to
 *   ~/.cairn/metrics/<project>.jsonl, tagged with the active cairn phase and
 *   issue so spend rolls up to the work items the tracker shows. Rows are
 *   cumulative per session: reports take the LATEST row per session_id.
 *   Also measures REPORT BYTES (#176) -- how much of a coordinator's context
 *   is subagent task results rather than its own work. Measurement only: it
 *   tells us whether report compression is worth building, nothing more.
 *   Fire-and-forget and throttled -- a hook must never be visible or block.
 * Author(s): John Reed
 */

import { readFileSync, readdirSync, statSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { metricsPath } from "./lib.mjs";

const THROTTLE_MS = 30_000;
const MAX_LINES = 5000;
const KEEP_LINES = 2500;

// Tools that fan work out to a subagent. Harnesses have called it both.
const TASK_TOOLS = new Set(["Task", "Agent"]);

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

/** Flatten a content field -- a bare string, or a block list -- to its text. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (typeof b === "string") out += b;
    else if (typeof b?.text === "string") out += b.text;
  }
  return out;
}

/**
 * One forward pass over the transcript: per-model usage, plus the bytes a
 * coordinator's context grew by because subagents reported back.
 *
 * A report reaches the coordinator two ways, and both are real context:
 *   - a `tool_result` answering a Task/Agent call -- the synchronous shape;
 *   - a `<task-notification>` user turn -- how an async agent's result lands.
 * An async fan-out produces BOTH (a small launch blob, then the real report),
 * so bytes sum over both while the fan-out COUNT dedupes them: a notification
 * names the tool-use id it answers, so a tool_result some notification
 * claimed is the same subagent reporting, not a second one.
 *
 * `queue-operation` rows carry the same notification text but never enter the
 * context window, so only `type: "user"` entries count.
 */
function scanTranscript(transcriptPath) {
  const totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set(),
    reportBytes: 0, reports: 0, reportTasks: 0, contextPeak: 0,
  };
  const fanoutIds = new Set();   // tool-use ids of the Task/Agent calls seen so far
  const resultIds = new Set();   // those that answered with a tool_result
  const claimedIds = new Set();  // those a task-notification later spoke for
  const taskIds = new Set();     // task ids the notifications named

  const raw = readFileSync(transcriptPath, "utf8");
  for (const line of raw.split("\n")) {
    const hasUsage = line.includes('"usage"');
    // Cheap prefilter -- a full JSON.parse only for lines that could matter.
    if (!hasUsage && !line.includes("tool_result") && !line.includes("tool_use")
      && !line.includes("task-notification")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type === "assistant") {
      const usage = entry.message?.usage;
      if (usage) {
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
        // Every input token of this one request IS the context at that turn.
        // Its peak is the only honest denominator for "how much of the window
        // were reports" -- the token SUMS multiply-count a replayed prefix
        // (one real session: 4k input, 19.6M cache writes, 957M cache reads).
        totals.contextPeak = Math.max(totals.contextPeak, inTok + cacheW + cacheR);
      }
      // Remember which calls fanned out, so their results are attributable.
      if (Array.isArray(entry.message?.content)) {
        for (const b of entry.message.content) {
          if (b?.type === "tool_use" && TASK_TOOLS.has(b.name)) fanoutIds.add(b.id);
        }
      }
      continue;
    }

    if (entry?.type !== "user") continue;
    const content = entry.message?.content;

    // Shape 1: the tool_result answering a Task/Agent call.
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== "tool_result" || !fanoutIds.has(b.tool_use_id)) continue;
        totals.reportBytes += Buffer.byteLength(contentText(b.content), "utf8");
        totals.reports += 1;
        resultIds.add(b.tool_use_id);
      }
    }

    // Shape 2: the <task-notification> an async agent's report arrives on.
    const text = contentText(content);
    if (!text.includes("<task-notification>")) continue;
    totals.reportBytes += Buffer.byteLength(text, "utf8");
    totals.reports += 1;
    const task = /<task-id>([^<]*)<\/task-id>/.exec(text);
    const claimed = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(text);
    if (task) taskIds.add(task[1]);
    if (claimed) claimedIds.add(claimed[1]);
  }

  // Fan-out width: every task that notified, plus every synchronous result no
  // notification spoke for.
  const fanout = new Set(taskIds);
  for (const id of resultIds) if (!claimedIds.has(id)) fanout.add(id);
  totals.reportTasks = fanout.size;

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

/**
 * What KIND of work this session's spend belongs to (#92) -- issue work,
 * an open trace/probe/draft/thread session, plain planning, or other.
 * Without this tag, survey and investigation spend vanishes from every
 * breakdown. Newest open session file wins when several kinds are open.
 */
function workKind(projectDir, ctx) {
  if (ctx.issue) return "issue";
  let newest = null;
  for (const kind of ["trace", "probe", "draft", "thread"]) {
    try {
      for (const f of readdirSync(join(projectDir, ".cairn", kind))) {
        if (!f.endsWith(".md")) continue; // archive/ subdir and stray files skip
        const m = statSync(join(projectDir, ".cairn", kind, f)).mtimeMs;
        if (!newest || m > newest.m) newest = { kind, m };
      }
    } catch { /* kind dir absent -- fine */ }
  }
  if (newest) return newest.kind;
  if (ctx.phase !== undefined) return "plan";
  return "other";
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

  const totals = scanTranscript(payload.transcript_path);
  if (totals.input + totals.output === 0) return;

  const ctx = activeContext(projectDir);
  const row = {
    ts: new Date().toISOString(),
    session_id: payload.session_id,
    ...ctx,
    kind: workKind(projectDir, ctx),
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_write_tokens: totals.cacheWrite,
    cache_read_tokens: totals.cacheRead,
    est_cost_usd: Number(totals.cost.toFixed(4)),
    // #176 -- context this coordinator spent on subagent reports, and the
    // fan-out width that produced them. Measurement, not a budget.
    report_bytes: totals.reportBytes,
    report_count: totals.reports,
    report_tasks: totals.reportTasks,
    context_peak_tokens: totals.contextPeak,
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
