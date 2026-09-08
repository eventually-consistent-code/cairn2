// Native-binding safeguard for better-sqlite3 (#108).
//
// Real incident: a fresh installed-plugin cache under a newer node ABI
// (node 26) had no compiled better-sqlite3 binding -- every memory index
// tool failed with a raw "Could not locate the bindings file" loader stack
// until someone manually rebuilt inside the cache's node_modules. This
// module makes that failure detect-and-explain: the require is lazy, the
// failure is recognized, and the typed error names the exact fix command
// with the real resolved server directory.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CairnError } from "../errors.js";
const nativeRequire = createRequire(import.meta.url);
// Signatures of "the compiled binding is missing or built for another
// runtime" -- everything else (disk full, corrupt install, ...) rethrows
// untranslated so we never mislabel an unrelated failure.
const BINDINGS_FAILURE_PATTERNS = [
    /could not locate the bindings file/i, // no build at all (the #108 incident)
    /was compiled against a different node\.js version/i, // ABI mismatch, loud form
    /node_module_version/i, // ABI mismatch, raw NODE_MODULE_VERSION form
    /invalid elf header/i, // binary from another platform (linux loader)
    /no suitable image found/i, // same, darwin loader
    /not a valid win32 application/i, // same, windows loader
    /better[-_]sqlite3\.node/i, // any other loader complaint naming the binding
];
/** True when `e` looks like a missing/incompatible compiled binding. */
export function isBindingsFailure(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return BINDINGS_FAILURE_PATTERNS.some((p) => p.test(msg));
}
/**
 * The directory holding the server's package.json -- where `npm rebuild`
 * must run. Walks up from this module's own location so it resolves
 * correctly from dist/ (installed plugin cache) and src/ (repo tree) alike.
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
/** The one-line fix command, against the real resolved server dir. */
export function rebuildFix(dir = serverDir()) {
    return `cd ${dir} && npm rebuild better-sqlite3`;
}
/** The typed, human-first error a bindings failure translates into. */
export function bindingsError(nodeVersion = process.version, dir = serverDir()) {
    return new CairnError("NATIVE_MODULE_BROKEN", `native module better-sqlite3 not built for this runtime (node ${nodeVersion}); ` +
        `run: ${rebuildFix(dir)}`, "a fresh plugin-cache install under a newer node ABI ships no compiled " +
        "binding -- rebuild once, then retry; card tools keep working meanwhile");
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
            throw bindingsError();
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
        return {
            module: "better-sqlite3",
            status: "broken",
            message: e instanceof Error ? e.message : String(e),
            fix: rebuildFix(),
        };
    }
}
