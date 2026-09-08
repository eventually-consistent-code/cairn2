import type Database from "better-sqlite3";
import { CairnError } from "../errors.js";
/** The better-sqlite3 constructor, as MemoryIndex consumes it. */
export type SqliteCtor = new (filename: string) => Database.Database;
/** Injectable loader seam -- tests simulate a broken binding here. */
export type SqliteLoader = () => SqliteCtor;
/** True when `e` looks like a missing/incompatible compiled binding. */
export declare function isBindingsFailure(e: unknown): boolean;
/**
 * The directory holding the server's package.json -- where `npm rebuild`
 * must run. Walks up from this module's own location so it resolves
 * correctly from dist/ (installed plugin cache) and src/ (repo tree) alike.
 */
export declare function serverDir(): string;
/** The one-line fix command, against the real resolved server dir. */
export declare function rebuildFix(dir?: string): string;
/** The typed, human-first error a bindings failure translates into. */
export declare function bindingsError(nodeVersion?: string, dir?: string): CairnError;
/**
 * Load the better-sqlite3 constructor, translating a bindings-file failure
 * into the typed NATIVE_MODULE_BROKEN error above. Any other failure
 * rethrows untouched. `requireFn` is a test seam only.
 */
export declare function loadSqlite(requireFn?: (id: string) => unknown): SqliteCtor;
export interface NativeProbe {
    module: "better-sqlite3";
    status: "ok" | "broken";
    message?: string;
    fix?: string;
}
/**
 * config_probe preflight (#108): attempt the require, report the outcome.
 * Advisory only -- this never throws, so a broken binding can never fail
 * the probe itself.
 */
export declare function probeNativeBindings(load?: SqliteLoader): NativeProbe;
