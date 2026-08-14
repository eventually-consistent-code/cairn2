#!/usr/bin/env node

/**
 * Purpose: TaskCreated/TaskCompleted hook -- append the native-Task event to
 *   the per-project spool at ~/.cairn/spool/ and get out of the way. Hooks
 *   BLOCK the session (probe #84 measured it), so this script does zero
 *   tracker I/O: one atomic append, then it spawns the detached mirror
 *   worker (if one isn't already running) and exits 0. The worker does the
 *   slow networked part on its own time.
 * Author(s): John Reed
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCairnConfig, spoolPath } from "./lib.mjs";

const EVENTS = new Set(["TaskCreated", "TaskCompleted"]);

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** True when the worker lock file names a live pid -- no second spawn then. */
function workerAlive(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const payload = readStdin();
  if (!payload?.session_id || !payload.task_id || !EVENTS.has(payload.hook_event_name)) return;

  // The spool row's project dir is what the worker mirrors against later.
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
  if (!readCairnConfig(projectDir)) return; // not a cairn project -- nothing to mirror to

  const spool = spoolPath(projectDir);
  mkdirSync(dirname(spool), { recursive: true });

  const row = {
    ts: new Date().toISOString(),
    event: payload.hook_event_name,
    session_id: payload.session_id,
    task_id: String(payload.task_id),
    subject: payload.task_subject ?? "",
    description: payload.task_description ?? "",
    project_dir: projectDir,
  };
  // One O_APPEND write of one full line -- concurrent hooks interleave whole
  // rows, never partial ones. tmp+rename would clobber a neighbor's append.
  appendFileSync(spool, JSON.stringify(row) + "\n");

  if (process.env.CAIRN_TASK_MIRROR_NO_SPAWN === "1") return; // tests drive the worker themselves
  if (workerAlive(`${spool}.lock`)) return;

  const worker = join(dirname(fileURLToPath(import.meta.url)), "task-mirror-worker.mjs");
  const child = spawn(process.execPath, [worker, projectDir], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  child.unref();
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
