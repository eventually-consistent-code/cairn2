// Native-binding safeguard for better-sqlite3 (#108, #178).
//
// Real incident: a fresh installed-plugin cache under a newer node ABI
// (node 26) had no compiled better-sqlite3 binding -- every memory index
// tool failed with a raw "Could not locate the bindings file" loader stack
// until someone manually rebuilt inside the cache's node_modules. This
// module makes that failure detect-and-explain: the require is lazy, the
// failure is recognized, and the typed error names the exact fix command
// against the directory the module actually resolves from.
//
// Follow-up (#178): the fix command used to hardcode the cache's `server/`
// subdirectory. Since the root-manifest migration the runtime deps install
// at the plugin-cache ROOT -- `server/node_modules` does not exist -- so a
// user following the instruction rebuilt nothing and hit the same error on
// reload. The rebuild path is now derived from the failed resolution, and
// the two failure modes are told apart: "never compiled here" (no artifact
// on disk at all) needs different next-action text from "compiled for a
// different runtime" (an artifact exists, aimed at another node ABI).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CairnError } from "../errors.js";
const nativeRequire = createRequire(import.meta.url);
const nativeResolve = (id) => nativeRequire.resolve(id);
// Signatures of "a binding exists but this runtime can't load it" -- ABI
// mismatch and wrong-platform binaries.
const ABI_FAILURE_PATTERNS = [
    /was compiled against a different node\.js version/i, // ABI mismatch, loud form
    /node_module_version/i, // ABI mismatch, raw NODE_MODULE_VERSION form
    /invalid elf header/i, // binary from another platform (linux loader)
    /no suitable image found/i, // same, darwin loader
    /not a valid win32 application/i, // same, windows loader
];
// Signatures of "there is no binding to load". Kept narrow on purpose: a
// bare "Cannot find module" must stay unclaimed so an unrelated missing
// dependency is never mislabeled as a native-build problem.
const ABSENT_FAILURE_PATTERNS = [
    /could not locate the bindings file/i, // no build at all (the #108 incident)
    /better[-_]sqlite3\.node/i, // loader complaint naming the binding itself
    /cannot find module ['"]better-sqlite3['"]/i, // the package isn't installed here
];
// Where a compiled artifact lands, whichever way it got there.
const ARTIFACT_CANDIDATES = [
    join("build", "Release", "better_sqlite3.node"),
    join("build", "Debug", "better_sqlite3.node"),
    "prebuilds",
];
/** True when `e` looks like a missing/incompatible compiled binding. */
export function isBindingsFailure(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [...ABI_FAILURE_PATTERNS, ...ABSENT_FAILURE_PATTERNS].some((p) => p.test(msg));
}
/**
 * The directory holding the server's package.json. Walks up from this
 * module's own location so it resolves from dist/ (installed plugin cache)
 * and src/ (repo tree) alike. Only a last-resort fallback now -- the
 * rebuild path comes from the real resolution, see `rebuildRoot`.
 */
export function serverDir() {
    let d = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(d, "package.json")))
            return d;
        const parent = dirname(d);
        if (parent === d)
            break;
        d = parent;
    }
    return d;
}
/**
 * The directory better-sqlite3 actually resolves from, or undefined when
 * the package cannot be resolved at all.
 *
 * :param resolve: resolver seam (defaults to this module's own require)
 */
export function nativePackageDir(resolve = nativeResolve) {
    // The package has no exports map, so its manifest resolves directly --
    // that is the package root with no guessing.
    try {
        return dirname(resolve("better-sqlite3/package.json"));
    }
    catch {
        /* fall through to the entry point */
    }
    // Older/odd layouts: resolve the entry and walk up to its manifest.
    try {
        let d = dirname(resolve("better-sqlite3"));
        for (let i = 0; i < 6; i++) {
            if (existsSync(join(d, "package.json")))
                return d;
            const parent = dirname(d);
            if (parent === d)
                break;
            d = parent;
        }
    }
    catch {
        /* not installed anywhere we can see */
    }
    return undefined;
}
/**
 * The directory to run `npm rebuild` in: the one owning the node_modules
 * that holds better-sqlite3. Since the root-manifest migration that is the
 * plugin-cache root, not `server/` -- hardcoding the latter is exactly the
 * #178 bug. Falls back to the server dir when nothing resolves.
 *
 * :param pkgDir: the resolved package dir (defaults to the live one)
 */
export function rebuildRoot(pkgDir = nativePackageDir()) {
    if (!pkgDir)
        return serverDir();
    let d = pkgDir;
    for (let i = 0; i < 8; i++) {
        if (basename(d) === "node_modules")
            return dirname(d);
        const parent = dirname(d);
        if (parent === d)
            break;
        d = parent;
    }
    return serverDir();
}
/** True when the resolved package has a compiled artifact on disk. */
export function bindingArtifactPresent(pkgDir) {
    if (!pkgDir)
        return false;
    return ARTIFACT_CANDIDATES.some((rel) => existsSync(join(pkgDir, rel)));
}
/**
 * Tell the two failure modes apart. Disk evidence wins over message
 * sniffing: if no artifact exists, nothing was compiled here no matter how
 * the loader phrased its complaint.
 *
 * :param e: the failure the loader threw
 * :param pkgDir: the resolved package dir (defaults to the live one)
 */
export function classifyBindingFailure(e, pkgDir = nativePackageDir()) {
    if (!bindingArtifactPresent(pkgDir))
        return "absent";
    const msg = e instanceof Error ? e.message : String(e);
    return ABI_FAILURE_PATTERNS.some((p) => p.test(msg)) ? "abi" : "absent";
}
/** The one-line fix command, against the real resolved rebuild root. */
export function rebuildFix(dir = rebuildRoot()) {
    return `cd ${dir} && npm rebuild better-sqlite3`;
}
// The second step, observed live (#156): the rebuild alone is not enough --
// the running server keeps its cached failed load until plugins reload.
const RELOAD_STEP = "then reload plugins (or restart the session) so the server picks up the new binding";
/** The typed error, carrying which failure mode produced it. */
export class NativeBindingError extends CairnError {
    kind;
    constructor(kind, message, nextAction) {
        super("NATIVE_MODULE_BROKEN", message, nextAction);
        this.kind = kind;
    }
}
/**
 * The typed, human-first error a bindings failure translates into.
 *
 * :param kind: which failure mode -- absent binding vs. wrong-runtime one
 * :param nodeVersion: the running node (defaults to this process)
 * :param dir: where to rebuild (defaults to the real resolution root)
 */
export function bindingsError(kind = "absent", nodeVersion = process.version, dir = rebuildRoot()) {
    const headline = kind === "abi"
        ? `native module better-sqlite3 was built for a different runtime (this is node ${nodeVersion})`
        : `native module better-sqlite3 has no compiled binding in this install (node ${nodeVersion})`;
    const why = kind === "abi"
        ? "the binding exists but targets another node ABI -- rebuild it where " +
            `better-sqlite3 actually resolves from (${dir}), ${RELOAD_STEP}, then ` +
            "retry"
        : "nothing was ever compiled here -- there is no binding to re-target, " +
            `so rebuild at the install root where the runtime deps live (${dir}), ` +
            "not the server/ subdirectory; if npm reports nothing to rebuild, run " +
            `npm install there first, ${RELOAD_STEP}, then retry`;
    return new NativeBindingError(kind, `${headline}; run: ${rebuildFix(dir)}, ${RELOAD_STEP}`, `${why}; card tools keep working meanwhile`);
}
/**
 * Load the better-sqlite3 constructor, translating a bindings-file failure
 * into the typed NATIVE_MODULE_BROKEN error above. Any other failure
 * rethrows untouched. `requireFn` is a test seam only.
 */
export function loadSqlite(requireFn = nativeRequire) {
    try {
        return requireFn("better-sqlite3");
    }
    catch (e) {
        if (isBindingsFailure(e))
            throw bindingsError(classifyBindingFailure(e));
        throw e;
    }
}
/**
 * config_probe preflight (#108): attempt the require, report the outcome.
 * Advisory only -- this never throws, so a broken binding can never fail
 * the probe itself.
 */
export function probeNativeBindings(load = loadSqlite) {
    try {
        load();
        return { module: "better-sqlite3", status: "ok" };
    }
    catch (e) {
        const kind = e instanceof NativeBindingError ? e.kind : classifyBindingFailure(e);
        return {
            module: "better-sqlite3",
            status: "broken",
            kind,
            message: e instanceof Error ? e.message : String(e),
            fix: `${rebuildFix()}, ${RELOAD_STEP}`,
        };
    }
}
