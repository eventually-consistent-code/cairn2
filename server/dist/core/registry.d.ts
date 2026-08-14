import { z } from "zod";
/**
 * The machine-wide project registry (#55/#87): every cairn project on this
 * machine, auto-registered as a side effect of the server starting there.
 * The outlook aggregate reads THIS file plus the snapshot mirrors -- it never
 * walks the filesystem hunting for repos. The absolute `path` field is
 * load-bearing: metrics filenames hash the path irreversibly, so joining
 * cost rows back to a project means re-hashing these registry paths.
 */
export interface RegistryEntry {
    name: string;
    path: string;
    firstSeen: string;
    lastSeen: string;
}
export interface Registry {
    version: 1;
    projects: RegistryEntry[];
}
export declare const RegistrySchema: z.ZodType<Registry>;
/**
 * `home` is injectable for tests only -- the registry is ONE shared file per
 * machine, and a test suite must never rewrite the real one mid-run.
 */
export declare function registryPath(home?: string): string;
/**
 * Reads the registry, tolerating absence and corruption the same way the
 * continuity reader does: a missing or unparseable file is an empty registry,
 * never an error -- a crashed write must not wedge every future aggregate.
 */
export declare function readRegistry(home?: string): Registry;
/**
 * Registers the project (or refreshes its lastSeen) in ~/.cairn/registry.json.
 * Mirrors writeHandoff's guards: only cairn projects register (CONFIG_MISSING
 * skips silently), and the write is atomic tmp+rename. Callers treat this as
 * fire-and-forget -- a registry failure must never fail server startup, so
 * anything thrown here is swallowed at the call site.
 */
export declare function registerProject(projectDir: string, home?: string): void;
