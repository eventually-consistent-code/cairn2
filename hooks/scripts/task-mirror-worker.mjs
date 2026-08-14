#!/usr/bin/env node

/**
 * Purpose: detached mirror worker -- drains the native-Task event spool that
 *   task-mirror-spool.mjs writes and mirrors each event to the project's
 *   tracker: TaskCreated opens an issue labeled cairn:task, TaskCompleted
 *   trues up the title (renames are invisible until close, probe #84) and
 *   closes it. Issues are keyed on (session_id, task_id) -- task ids are
 *   per-session counters and collide across sessions -- via a small map file
 *   beside the spool. Tracker errors retry with backoff; whatever still
 *   fails stays in the spool for the next run (offline durability). This is
 *   the only mirror piece that imports server code -- it runs detached, so
 *   it can afford to.
 * Author(s): John Reed
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson, readJson, spoolMapPath, spoolPath } from "./lib.mjs";


// Constants

const projectDir = process.argv[2] ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const SPOOL = spoolPath(projectDir);
const WORK = `${SPOOL}.work`; // claimed batch -- survives a crash, replays idempotently
const LOCK = `${SPOOL}.lock`;
const MAP = spoolMapPath(projectDir);

// Retry pauses between tracker attempts; tests shrink these via env.
const BACKOFF_MS = (process.env.CAIRN_TASK_MIRROR_BACKOFF_MS ?? "1000,5000,15000")
  .split(",")
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n >= 0);


// Helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single-worker guard: write our pid with wx (fails if held). A lock whose
 * pid is dead is a crashed worker -- clear it and try once more.
 */
function acquireLock() {
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(dirname(LOCK), { recursive: true });
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = Number(readFileSync(LOCK, "utf8").trim());
        process.kill(pid, 0);
        return false; // a live worker has it -- it will drain what we spooled
      } catch {
        rmSync(LOCK, { force: true }); // stale -- reclaim on the next pass
      }
    }
  }
  return false;
}

/** Run `fn`, retrying across the backoff schedule before giving up. */
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= BACKOFF_MS.length) throw e;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}

/** Issue body: the task's own description plus a plain-language provenance note. */
function mirrorBody(row) {
  const note =
    "This item mirrors a task from the assistant's in-session task list -- " +
    "created automatically for visibility, and it closes itself when the " +
    `in-session task completes. (session ${row.session_id}, task ${row.task_id})`;
  return row.description ? `${row.description}\n\n---\n${note}\n` : `${note}\n`;
}

/**
 * Mirror one spool row. Idempotent by construction: a replayed TaskCreated
 * whose key is already mapped is a no-op, and re-closing a closed issue is
 * harmless -- so a crash between tracker write and spool rewrite is safe.
 */
async function processRow(tracker, map, row) {
  const key = `${row.session_id}:${row.task_id}`;

  if (row.event === "TaskCreated") {
    if (map[key]) return; // already mirrored (crash replay)
    const issue = await withRetry(() => tracker.createIssue({
      title: row.subject || `task ${row.task_id}`,
      body: mirrorBody(row),
      labels: ["cairn:task"],
    }));
    map[key] = issue.id;
    atomicWriteJson(MAP, map);
    return;
  }

  if (row.event === "TaskCompleted") {
    const issueId = map[key];
    if (!issueId) return; // task predates the mirror -- nothing to close
    await withRetry(async () => {
      // Completion payload carries the FINAL subject -- true up a rename.
      if (row.subject) await tracker.updateIssue(issueId, { title: row.subject });
      await tracker.closeIssue(issueId);
    });
  }
}

/**
 * Claim the spool (rename -> .work; hooks then append to a fresh spool) and
 * mirror its rows in order. On a row that still fails after retries, put
 * that row and everything after it back and stop -- order is meaningful
 * (created before completed) and the next run picks up where we left off.
 */
async function drain(tracker) {
  let map = {};
  try {
    map = readJson(MAP);
  } catch {
    // no map yet, or corrupt -- start fresh; TaskCreated rebuilds it
  }

  for (;;) {
    if (!existsSync(WORK)) {
      if (!existsSync(SPOOL)) return; // drained -- done
      renameSync(SPOOL, WORK);
    }

    const rows = readFileSync(WORK, "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < rows.length; i++) {
      let row;
      try {
        row = JSON.parse(rows[i]);
      } catch {
        continue; // corrupt line -- skip it, keep draining
      }
      try {
        await processRow(tracker, map, row);
      } catch {
        // tracker still down after retries -- leave this row and the rest
        // in place (offline durability) and bow out quietly.
        writeFileSync(WORK, rows.slice(i).join("\n") + "\n");
        return;
      }
    }
    rmSync(WORK, { force: true }); // batch done -- loop back for anything spooled meanwhile
  }
}


// Main

async function main() {
  if (!acquireLock()) return;
  try {
    // Server dist is a sibling of the plugin's hooks/ dir. Import inside the
    // guarded path: a missing build just leaves the spool for a later run.
    const { loadConfig } = await import(new URL("../../server/dist/config.js", import.meta.url).href);
    const { makeTracker } = await import(new URL("../../server/dist/tracker/registry.js", import.meta.url).href);
    const cfg = loadConfig(projectDir);
    const tracker = await makeTracker(cfg, projectDir);
    await drain(tracker);
  } finally {
    rmSync(LOCK, { force: true });
  }
}

try {
  await main();
} catch {
  // swallowed by design -- a mirror worker must never crash loudly; the
  // spool keeps whatever we could not deliver.
}
process.exit(0);
