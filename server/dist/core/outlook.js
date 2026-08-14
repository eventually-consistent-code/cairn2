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
import { readRegistry } from "./registry.js";
export const OutlookSnapshotSchema = z.object({
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
function pathHash(projectDir) {
    const abs = resolve(projectDir);
    const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
    return { base: basename(abs), hash };
}
/** The machine-wide mirror the aggregate reads (never walks repos). */
export function outlookMirrorPath(projectDir, home = homedir()) {
    const { base, hash } = pathHash(projectDir);
    return join(home, ".cairn", "outlook", `${base}-${hash}.json`);
}
/** The in-repo copy -- travels with the project, diffable when committed. */
export function outlookLocalPath(projectDir) {
    return join(resolve(projectDir), ".cairn", "outlook.json");
}
function atomicWrite(path, snapshot) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
    renameSync(tmp, path);
}
function readSnapshot(path) {
    if (!existsSync(path))
        return null;
    try {
        const parsed = OutlookSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
function gitHead(projectDir) {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: resolve(projectDir), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
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
export function emitOutlook(projectDir, patch, home) {
    try {
        loadConfig(projectDir);
    }
    catch (e) {
        if (e instanceof CairnError && e.code === "CONFIG_MISSING")
            return;
        throw e;
    }
    const abs = resolve(projectDir);
    const mirror = outlookMirrorPath(projectDir, home);
    const previous = readSnapshot(mirror);
    const status = projectStatus(abs);
    const landscape = sessionLandscape(abs);
    const snapshot = {
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
export function readOutlook(projectDir, home) {
    return readSnapshot(outlookMirrorPath(projectDir, home));
}
/**
 * The portfolio aggregate (#89): registry + mirror snapshots ONLY -- never
 * walks the filesystem for repos. Staleness is the card pattern, not a
 * date: the snapshot's recorded HEAD vs the repo's live HEAD. Per-project
 * failures become `{name, error}` cards (workspace_status precedent);
 * one broken project can never take down the board.
 */
export function outlookAggregate(home) {
    const registry = readRegistry(home);
    const projects = [];
    for (const entry of registry.projects) {
        try {
            const snapshot = readOutlook(entry.path, home) ?? undefined;
            const card = {
                name: entry.name, path: entry.path, lastSeen: entry.lastSeen, snapshot,
            };
            if (!snapshot) {
                card.error = "no snapshot yet -- run any cairn verb in this project to emit one";
            }
            else if (snapshot.head !== undefined) {
                // Frontmatter-adjacent data is attacker-influenceable; validate the
                // recorded sha before shelling out (same rule as card staleness).
                if (!/^[0-9a-f]{4,40}$/i.test(snapshot.head)) {
                    card.stale = true;
                    card.staleReason = "snapshot records an invalid commit id";
                }
                else {
                    const live = gitHead(entry.path);
                    if (live !== undefined && live !== snapshot.head) {
                        card.stale = true;
                        card.staleReason = `repo moved since snapshot (${snapshot.head.slice(0, 7)} -> ${live.slice(0, 7)})`;
                    }
                    else {
                        card.stale = false;
                    }
                }
            }
            projects.push(card);
        }
        catch (e) {
            projects.push({
                name: entry.name, path: entry.path, lastSeen: entry.lastSeen,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    return { projects };
}
