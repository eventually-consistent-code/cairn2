#!/usr/bin/env node

/**
 * Purpose: shared, dependency-free helpers for cairn's plugin hook scripts
 *   (posttooluse-breadcrumb, precompact-refresh, sessionstart-continuity).
 *   node: builtins only -- these scripts must never import server code, so
 *   the handoff/banner path scheme is recomputed here rather than reused
 *   from server/src/core/continuity.ts (which stays the source of truth).
 * Author(s): John Reed
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Same per-machine hashing scheme as server/src/core/continuity.ts's pathHash.
function pathHash(projectDir) {
  const abs = resolve(projectDir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return { base: basename(abs), hash };
}

export function handoffPath(projectDir) {
  const { base, hash } = pathHash(projectDir);
  return join(homedir(), ".cairn", "handoff", `${base}-${hash}.json`);
}

export function bannerPath(projectDir) {
  const { base, hash } = pathHash(projectDir);
  return join(homedir(), ".cairn", "banner", `${base}-${hash}.md`);
}

export function metricsPath(projectDir) {
  const { base, hash } = pathHash(projectDir);
  return join(homedir(), ".cairn", "metrics", `${base}-${hash}.jsonl`);
}

/** mtime in ms of `path`, or null when it doesn't exist. */
export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Reads + JSON.parses `path`. Throws on missing/corrupt -- callers decide how to handle it. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Same tmp+rename atomic write as writeHandoff in server/src/core/continuity.ts. */
export function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Reads cairn.json in `projectDir` directly (plain JSON, no zod). Returns null when absent/invalid. */
export function readCairnConfig(projectDir) {
  try {
    return JSON.parse(readFileSync(join(projectDir, "cairn.json"), "utf8"));
  } catch {
    return null;
  }
}

/** `continuity.resume`, defaulting to "prompt" when cairn.json, continuity, or resume is absent/invalid. */
export function resumeMode(projectDir) {
  const resume = readCairnConfig(projectDir)?.continuity?.resume;
  return resume === "auto" || resume === "off" ? resume : "prompt";
}

/**
 * Bare file paths from `git status --porcelain`, capped at `cap`. Best-effort --
 * a non-git dir or missing git binary yields [] rather than throwing, so a
 * breadcrumb write still lands with an empty uncommitted_files list.
 */
export function uncommittedFiles(projectDir, cap = 20) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n")
      .filter((line) => line.length > 0)
      .slice(0, cap)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

/** "just now" / "5m" / "3h" / "2d" -- compact age since an ISO timestamp. */
export function humanizeAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export { existsSync };
