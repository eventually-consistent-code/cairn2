#!/usr/bin/env node

/**
 * Purpose: PostToolUse hook -- append one lightweight observation row per
 *   Edit/Write/Bash call to .cairn/observations/observations.jsonl: which
 *   tool, which target, did it error. Raw material for retro's candidate-card
 *   review (repeated error->fix churn, hotspot files) -- observations NEVER
 *   inject into context or become memory on their own; retro is the gate.
 *   Only fires in cairn-initialized projects (.cairn/ exists). Capped,
 *   fire-and-forget, invisible on failure.
 * Author(s): John Reed
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_LINES = 2000;
const KEEP_LINES = 1000;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** A short, leak-safe target label: file basename-ish path or command head. */
function targetOf(payload) {
  const input = payload.tool_input ?? {};
  if (typeof input.file_path === "string") return input.file_path.slice(-120);
  if (typeof input.command === "string") return input.command.slice(0, 80);
  return undefined;
}

function errored(payload) {
  const resp = payload.tool_response;
  if (resp == null) return false;
  if (resp.is_error === true || resp.success === false) return true;
  if (typeof resp.exit_code === "number" && resp.exit_code !== 0) return true;
  return false;
}

function main() {
  const payload = readStdin();
  if (!payload?.tool_name) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (!existsSync(join(projectDir, ".cairn"))) return; // cairn projects only

  const dir = join(projectDir, ".cairn", "observations");
  const path = join(dir, "observations.jsonl");
  const row = {
    ts: new Date().toISOString(),
    session_id: payload.session_id,
    tool: payload.tool_name,
    target: targetOf(payload),
    error: errored(payload),
  };
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");

  // Retention guard (CRN-27): the log must not grow unbounded.
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_LINES) {
    writeFileSync(path, lines.slice(-KEEP_LINES).join("\n") + "\n");
  }
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
