#!/usr/bin/env node

/**
 * Purpose: SessionStart hook -- inject the project's recall banner (if any)
 *   and a compact resume block (if a handoff exists and continuity.resume
 *   isn't "off") as additionalContext, so a new session picks up where the
 *   last one left off without the user re-explaining state. Fire-and-forget:
 *   any error, or nothing to show, is a silent no-op.
 * Author(s): John Reed
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  handoffPath, bannerPath, mtimeMs, readJson, resumeMode, humanizeAge, existsSync,
} from "./lib.mjs";

/** Compact resume block: phase, issue, current task, next_action, age. Phrasing depends on mode. */
function buildResumeBlock(handoff, mode) {
  const age = humanizeAge(handoff.created);
  const ageLabel = age === "just now" ? age : `${age} ago`;
  const lines = [`## cairn session handoff (${ageLabel})`];
  if (handoff.phase) lines.push(`- phase: ${handoff.phase.number} (${handoff.phase.slug})`);
  if (handoff.issue) lines.push(`- issue: ${handoff.issue}`);
  if (handoff.task?.current) {
    const title = handoff.task.title ? ` — ${handoff.task.title}` : "";
    lines.push(`- current task: ${handoff.task.current}${title}`);
  }
  if (handoff.next_action) lines.push(`- next action: ${handoff.next_action}`);
  lines.push("");
  lines.push(mode === "auto"
    ? "A previous session handoff exists -- resume it now: pick up the next action above without asking the user first."
    : "A previous session handoff exists. Ask the user whether to resume this task before starting anything else.");
  return lines.join("\n");
}

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const parts = [];

  const bp = bannerPath(projectDir);
  if (existsSync(bp)) {
    const bannerText = readFileSync(bp, "utf8").trim();
    if (bannerText.length > 0) parts.push(bannerText);
  }

  const hp = handoffPath(projectDir);
  const mode = resumeMode(projectDir);
  if (mtimeMs(hp) !== null && mode !== "off") {
    const handoff = readJson(hp);
    parts.push(buildResumeBlock(handoff, mode));
  }

  // Tracker-delta staleness nudge — local read only, never network.
  try {
    const marker = JSON.parse(readFileSync(
      join(projectDir, ".cairn", "tracker-marker.json"), "utf8"));
    const ageMs = Date.now() - Date.parse(marker.lastScan);
    if (ageMs > 12 * 60 * 60 * 1000) {
      parts.push("tracker delta unchecked since " + marker.lastScan +
        " — the next /cairn:status, /cairn:plan, or /cairn:work scans it.");
    }
  } catch { /* no marker or unreadable: no nudge */ }

  if (parts.length === 0) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: parts.join("\n\n"),
    },
  }));
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
