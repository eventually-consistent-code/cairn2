import type Database from "better-sqlite3";
import { CairnError } from "../errors.js";
/** The better-sqlite3 constructor, as MemoryIndex consumes it. */
export type SqliteCtor = new (filename: string) => Database.Database;
/** Injectable loader seam -- tests simulate a broken binding here. */
export type SqliteLoader = () => SqliteCtor;
/** Injectable resolver seam -- tests simulate an install layout here. */
export type ResolveFn = (id: string) => string;
/**
 * How a bindings failure actually failed. They read the same to a loader
 * but need different instructions, so they are never collapsed:
 * - `absent` -- nothing was ever compiled in this install (the #178 case)
 * - `abi`    -- a binding exists, built for another node runtime/platform
 */
export type BindingFailureKind = "absent" | "abi";
/** True when `e` looks like a missing/incompatible compiled binding. */
export declare function isBindingsFailure(e: unknown): boolean;
/**
 * The directory holding the server's package.json. Walks up from this
 * module's own location so it resolves from dist/ (installed plugin cache)
 * and src/ (repo tree) alike. Only a last-resort fallback now -- the
 * rebuild path comes from the real resolution, see `rebuildRoot`.
 */
export declare function serverDir(): string;
/**
 * The directory better-sqlite3 actually resolves from, or undefined when
 * the package cannot be resolved at all.
 *
 * :param resolve: resolver seam (defaults to this module's own require)
 */
export declare function nativePackageDir(resolve?: ResolveFn): string | undefined;
/**
 * The directory to run `npm rebuild` in: the one owning the node_modules
 * that holds better-sqlite3. Since the root-manifest migration that is the
 * plugin-cache root, not `server/` -- hardcoding the latter is exactly the
 * #178 bug. Falls back to the server dir when nothing resolves.
 *
 * :param pkgDir: the resolved package dir (defaults to the live one)
 */
export declare function rebuildRoot(pkgDir?: string | undefined): string;
/** True when the resolved package has a compiled artifact on disk. */
export declare function bindingArtifactPresent(pkgDir: string | undefined): boolean;
/**
 * Tell the two failure modes apart. Disk evidence wins over message
 * sniffing: if no artifact exists, nothing was compiled here no matter how
 * the loader phrased its complaint.
 *
 * :param e: the failure the loader threw
 * :param pkgDir: the resolved package dir (defaults to the live one)
 */
export declare function classifyBindingFailure(e: unknown, pkgDir?: string | undefined): BindingFailureKind;
/** The one-line fix command, against the real resolved rebuild root. */
export declare function rebuildFix(dir?: string): string;
/** The typed error, carrying which failure mode produced it. */
export declare class NativeBindingError extends CairnError {
    readonly kind: BindingFailureKind;
    constructor(kind: BindingFailureKind, message: string, nextAction: string);
}
/**
 * The typed, human-first error a bindings failure translates into.
 *
 * :param kind: which failure mode -- absent binding vs. wrong-runtime one
 * :param nodeVersion: the running node (defaults to this process)
 * :param dir: where to rebuild (defaults to the real resolution root)
 */
export declare function bindingsError(kind?: BindingFailureKind, nodeVersion?: string, dir?: string): NativeBindingError;
/**
 * Load the better-sqlite3 constructor, translating a bindings-file failure
 * into the typed NATIVE_MODULE_BROKEN error above. Any other failure
 * rethrows untouched. `requireFn` is a test seam only.
 */
export declare function loadSqlite(requireFn?: (id: string) => unknown): SqliteCtor;
export interface NativeProbe {
    module: "better-sqlite3";
    status: "ok" | "broken";
    kind?: BindingFailureKind;
    message?: string;
    fix?: string;
}
/**
 * config_probe preflight (#108): attempt the require, report the outcome.
 * Advisory only -- this never throws, so a broken binding can never fail
 * the probe itself.
 */
export declare function probeNativeBindings(load?: SqliteLoader): NativeProbe;
