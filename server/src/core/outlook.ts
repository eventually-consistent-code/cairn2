import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { projectStatus } from "../planning/status.js";
import { sessionLandscape } from "../sessions/store.js";

/**
 * The outlook snapshot (#55/#88): a compact, machine-readable "where this
 * project stands" written as a side effect of state-changing tool calls.
 * Everything derivable locally is re-derived fresh on every emit; the
 * `tracker` block is verb-supplied (issue counts, next verb) and merges
 * forward from the previous snapshot so a plain emit can't erase it.
 * Zero network at emit time, always.
 */

export interface OutlookPhase {
  number: number;
  name: string;
  planned: boolean;
  verified: boolean;
  issueCount: number;
}

export interface OutlookTracker {
  open?: number;
  inProgress?: number;
  blocked?: number;
  nextVerb?: string;
  asOf?: string;
}

export interface OutlookSnapshot {
  version: 1;
  ts: string;
  name: string;
  path: string;
  head?: string;
  phases: OutlookPhase[];
  sessions: { trace: number; probe: number; draft: number; thread: number };
  tracker?: OutlookTracker;
}

export const OutlookSnapshotSchema: z.ZodType<OutlookSnapshot> = z.object({
  version: z.literal(1),
  ts: z.string(),
  name: z.string(),
  path: z.string(),
  head: z.string().optional(),
  phases: z.array(z.object({
    number: z.number(),
    name: z.string(),
    planned: z.boolean(),
    verified: z.boolean(),
    issueCount: z.number(),
  })),
  sessions: z.object({
    trace: z.number(), probe: z.number(), draft: z.number(), thread: z.number(),
  }),
  tracker: z.object({
    open: z.number().optional(),
    inProgress: z.number().optional(),
    blocked: z.number().optional(),
    nextVerb: z.string().optional(),
    asOf: z.string().optional(),
  }).optional(),
});

/** Same per-machine hashing scheme as handoffPath/indexDbPath. */
function pathHash(projectDir: string): { base: string; hash: string } {
  const abs = resolve(projectDir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return { base: basename(abs), hash };
}

/** The machine-wide mirror the aggregate reads (never walks repos). */
export function outlookMirrorPath(projectDir: string, home: string = homedir()): string {
  const { base, hash } = pathHash(projectDir);
  return join(home, ".cairn", "outlook", `${base}-${hash}.json`);
}

/** The in-repo copy -- travels with the project, diffable when committed. */
export function outlookLocalPath(projectDir: string): string {
  return join(resolve(projectDir), ".cairn", "outlook.json");
}

function atomicWrite(path: string, snapshot: OutlookSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
  renameSync(tmp, path);
}

function readSnapshot(path: string): OutlookSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = OutlookSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function gitHead(projectDir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(projectDir), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Derives a fresh snapshot and dual-writes it (in-repo + machine mirror),
 * both atomic. Mirrors writeHandoff's guards: unregistered projects skip
 * silently (CONFIG_MISSING), and the previous snapshot's verb-supplied
 * `tracker` block carries forward unless this emit brings a newer one --
 * the outlook cousin of the handoff's monotonic-richness rule.
 *
 * Callers treat this as fire-and-forget; the refreshHandoff wrapper (and
 * any other call site) swallows what this throws.
 */
export function emitOutlook(projectDir: string, patch?: { tracker?: OutlookTracker },
                            home?: string): void {
  try {
    loadConfig(projectDir);
  } catch (e) {
    if (e instanceof CairnError && e.code === "CONFIG_MISSING") return;
    throw e;
  }

  const abs = resolve(projectDir);
  const mirror = outlookMirrorPath(projectDir, home);
  const previous = readSnapshot(mirror);

  const status = projectStatus(abs);
  const landscape = sessionLandscape(abs);

  const snapshot: OutlookSnapshot = {
    version: 1,
    ts: new Date().toISOString(),
    name: basename(abs),
    path: abs,
    head: gitHead(abs),
    phases: status.phases.map((p) => ({
      number: p.number,
      name: p.name,
      planned: p.hasPlan,
      verified: p.hasVerification,
      issueCount: p.issues.length,
    })),
    sessions: landscape.openByKind,
    tracker: patch?.tracker ?? previous?.tracker,
  };

  atomicWrite(mirror, snapshot);
  atomicWrite(outlookLocalPath(projectDir), snapshot);
}

/** Reads a project's mirror snapshot; corrupt or missing reads as null. */
export function readOutlook(projectDir: string, home?: string): OutlookSnapshot | null {
  return readSnapshot(outlookMirrorPath(projectDir, home));
}
