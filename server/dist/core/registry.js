import { z } from "zod";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../config.js";
const RegistryEntrySchema = z.object({
    name: z.string(),
    path: z.string(),
    firstSeen: z.string(),
    lastSeen: z.string(),
});
export const RegistrySchema = z.object({
    version: z.literal(1),
    projects: z.array(RegistryEntrySchema),
});
/**
 * `home` is injectable for tests only -- the registry is ONE shared file per
 * machine, and a test suite must never rewrite the real one mid-run.
 */
export function registryPath(home = homedir()) {
    return join(home, ".cairn", "registry.json");
}
/**
 * Reads the registry, tolerating absence and corruption the same way the
 * continuity reader does: a missing or unparseable file is an empty registry,
 * never an error -- a crashed write must not wedge every future aggregate.
 */
export function readRegistry(home) {
    const path = registryPath(home);
    if (!existsSync(path))
        return { version: 1, projects: [] };
    try {
        const parsed = RegistrySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : { version: 1, projects: [] };
    }
    catch {
        return { version: 1, projects: [] };
    }
}
/**
 * Registers the project (or refreshes its lastSeen) in ~/.cairn/registry.json.
 * Mirrors writeHandoff's guards: only cairn projects register (CONFIG_MISSING
 * skips silently), and the write is atomic tmp+rename. Callers treat this as
 * fire-and-forget -- a registry failure must never fail server startup, so
 * anything thrown here is swallowed at the call site.
 */
export function registerProject(projectDir, home) {
    try {
        loadConfig(projectDir);
    }
    catch {
        return; // not a cairn project (or unreadable config) -- nothing to register
    }
    const abs = resolve(projectDir);
    const now = new Date().toISOString();
    const registry = readRegistry(home);
    const existing = registry.projects.find((p) => p.path === abs);
    if (existing) {
        existing.lastSeen = now;
        existing.name = basename(abs);
    }
    else {
        registry.projects.push({ name: basename(abs), path: abs, firstSeen: now, lastSeen: now });
    }
    const path = registryPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n");
    renameSync(tmp, path);
}
