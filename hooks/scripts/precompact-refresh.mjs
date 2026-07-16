#!/usr/bin/env node

/**
 * Purpose: PreCompact hook -- right before context compaction, refresh the
 *   project's ~/.cairn/handoff/*.json breadcrumb (created, source,
 *   uncommitted_files) so the handoff reflects state as of the compaction
 *   boundary. Unlike the PostToolUse breadcrumb, this one is unthrottled --
 *   compaction is rare enough that every occurrence deserves a fresh write.
 *   Fire-and-forget: any error, or no handoff to patch, is a silent no-op.
 * Author(s): John Reed
 */

import { handoffPath, mtimeMs, readJson, atomicWriteJson, uncommittedFiles } from "./lib.mjs";

function main() {
  const cwd = process.cwd();
  const path = handoffPath(cwd);

  if (mtimeMs(path) === null) return; // no handoff yet -- nothing to patch

  const existing = readJson(path);
  const merged = {
    ...existing,
    created: new Date().toISOString(),
    source: "precompact",
    uncommitted_files: uncommittedFiles(cwd),
  };
  atomicWriteJson(path, merged);
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
