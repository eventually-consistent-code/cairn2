// Native-binding safeguard tests (#108) -- all failure paths are simulated
// via the injectable loader/require seams, never by breaking the real
// compiled binding.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CairnError } from "../src/errors.js";
import {
  bindingArtifactPresent,
  bindingsError,
  classifyBindingFailure,
  isBindingsFailure,
  loadSqlite,
  nativePackageDir,
  probeNativeBindings,
  rebuildFix,
  rebuildRoot,
  serverDir,
} from "../src/memory/native.js";
import { MemoryIndex } from "../src/memory/index-store.js";

// The raw message from the real incident: fresh plugin cache + node 26,
// no compiled binding at all.
const RAW_BINDINGS_MSG =
  "Could not locate the bindings file. Tried:\n" +
  " → /cache/node_modules/better-sqlite3/build/better_sqlite3.node";

describe("isBindingsFailure", () => {
  it("recognizes the missing-bindings loader error (the #108 incident)", () => {
    expect(isBindingsFailure(new Error(RAW_BINDINGS_MSG))).toBe(true);
  });

  it("recognizes an ABI mismatch (module built for an older node)", () => {
    expect(
      isBindingsFailure(
        new Error(
          "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes a wrong-platform binary and loader complaints naming the binding", () => {
    expect(isBindingsFailure(new Error("invalid ELF header"))).toBe(true);
    expect(
      isBindingsFailure(
        new Error("dlopen(...): no suitable image found"),
      ),
    ).toBe(true);
    expect(
      isBindingsFailure(
        new Error("Cannot find module './build/Release/better_sqlite3.node'"),
      ),
    ).toBe(true);
  });

  it("does NOT claim unrelated failures", () => {
    expect(isBindingsFailure(new Error("ENOSPC: no space left on device"))).toBe(false);
    expect(isBindingsFailure(new Error("Cannot find module 'left-pad'"))).toBe(false);
    expect(isBindingsFailure("just a string")).toBe(false);
  });
});

describe("serverDir", () => {
  it("resolves the real server package dir (holds package.json)", () => {
    const d = serverDir();
    expect(d.endsWith("server")).toBe(true);
  });
});

describe("nativePackageDir / rebuildRoot (#178)", () => {
  it("finds the dir the native package really resolves from", () => {
    const d = nativePackageDir();
    expect(d).toBeDefined();
    expect(basename(d as string)).toBe("better-sqlite3");
  });

  it("is undefined when the native package resolves nowhere", () => {
    expect(
      nativePackageDir(() => {
        throw new Error("Cannot find module 'better-sqlite3'");
      }),
    ).toBeUndefined();
  });

  it("rebuilds at the install root, NOT the server/ subdirectory", () => {
    // The #178 layout: root-manifest migration puts the runtime deps at the
    // plugin-cache ROOT, so cache/server/node_modules never exists.
    const pkgDir = nativePackageDir(
      () => "/plugin/cache/node_modules/better-sqlite3/package.json",
    ) as string;
    expect(rebuildRoot(pkgDir)).toBe("/plugin/cache");
    expect(rebuildFix(rebuildRoot(pkgDir))).toBe(
      "cd /plugin/cache && npm rebuild better-sqlite3",
    );
    expect(rebuildFix(rebuildRoot(pkgDir))).not.toContain("/server ");
  });

  it("picks the nearest owner of a nested node_modules", () => {
    expect(
      rebuildRoot("/cache/node_modules/dep/node_modules/better-sqlite3"),
    ).toBe("/cache/node_modules/dep");
  });

  it("falls back to the server dir when nothing resolves", () => {
    expect(rebuildRoot(undefined)).toBe(serverDir());
  });

  it("rebuildFix names the exact command against the live root", () => {
    expect(rebuildFix()).toBe(`cd ${rebuildRoot()} && npm rebuild better-sqlite3`);
  });
});

describe("bindingArtifactPresent / classifyBindingFailure (#178)", () => {
  it("sees the real compiled artifact on disk", () => {
    expect(bindingArtifactPresent(nativePackageDir())).toBe(true);
    expect(bindingArtifactPresent(undefined)).toBe(false);
  });

  it("calls it absent when no artifact was ever compiled there", () => {
    const empty = mkdtempSync(join(tmpdir(), "cairn-nobind-"));
    try {
      expect(bindingArtifactPresent(empty)).toBe(false);
      // Disk evidence outranks the loader wording -- even an ABI-flavored
      // message is "absent" when there is nothing on disk to re-target.
      expect(
        classifyBindingFailure(
          new Error("NODE_MODULE_VERSION 115"),
          empty,
        ),
      ).toBe("absent");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("calls it abi when an artifact exists but the runtime rejects it", () => {
    const pkg = nativePackageDir();
    expect(
      classifyBindingFailure(
        new Error(
          "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.",
        ),
        pkg,
      ),
    ).toBe("abi");
    expect(classifyBindingFailure(new Error("invalid ELF header"), pkg)).toBe(
      "abi",
    );
    // A "no bindings file" complaint is the absent mode, artifact or not.
    expect(classifyBindingFailure(new Error(RAW_BINDINGS_MSG), pkg)).toBe(
      "absent",
    );
  });
});

describe("bindingsError", () => {
  it("is a typed NATIVE_MODULE_BROKEN naming runtime and fix", () => {
    const e = bindingsError("abi", "v26.0.0", "/plugin/cache");
    expect(e).toBeInstanceOf(CairnError);
    expect(e.code).toBe("NATIVE_MODULE_BROKEN");
    expect(e.kind).toBe("abi");
    expect(e.message).toBe(
      "native module better-sqlite3 was built for a different runtime " +
        "(this is node v26.0.0); " +
        "run: cd /plugin/cache && npm rebuild better-sqlite3, " +
        "then reload plugins (or restart the session) so the server picks up the new binding",
    );
    expect(e.nextAction).toContain("the binding exists but targets another node ABI");
    expect(e.nextAction).toContain("then retry");
    expect(e.nextAction).toContain("card tools keep working meanwhile");
  });

  it("describes the absent case differently -- nothing to re-target (#178)", () => {
    const e = bindingsError("absent", "v26.0.0", "/plugin/cache");
    expect(e.kind).toBe("absent");
    expect(e.message).toBe(
      "native module better-sqlite3 has no compiled binding in this install " +
        "(node v26.0.0); " +
        "run: cd /plugin/cache && npm rebuild better-sqlite3, " +
        "then reload plugins (or restart the session) so the server picks up the new binding",
    );
    expect(e.nextAction).toContain("nothing was ever compiled here");
    expect(e.nextAction).toContain("not the server/ subdirectory");
    expect(e.nextAction).toContain("npm install there first");
  });

  it("never points the rebuild at a server/ dir that has no node_modules", () => {
    const pkgDir = nativePackageDir(
      () => "/plugin/cache/node_modules/better-sqlite3/package.json",
    ) as string;
    const e = bindingsError("absent", "v26.0.0", rebuildRoot(pkgDir));
    expect(e.message).toContain("cd /plugin/cache && npm rebuild");
    expect(e.message).not.toContain("/plugin/cache/server");
  });
});

describe("loadSqlite", () => {
  it("translates a simulated bindings failure into NATIVE_MODULE_BROKEN", () => {
    const failingRequire = () => {
      throw new Error(RAW_BINDINGS_MSG);
    };
    let caught: unknown;
    try {
      loadSqlite(failingRequire);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CairnError);
    const ce = caught as CairnError;
    expect(ce.code).toBe("NATIVE_MODULE_BROKEN");
    expect(ce.message).toContain(`(node ${process.version})`);
    expect(ce.message).toContain("npm rebuild better-sqlite3");
    // Never the raw loader stack.
    expect(ce.message).not.toContain("Could not locate the bindings file");
  });

  it("rethrows non-bindings failures untranslated", () => {
    const failingRequire = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    expect(() => loadSqlite(failingRequire)).toThrowError(
      "ENOSPC: no space left on device",
    );
  });

  it("loads the real module when the binding is healthy", () => {
    expect(typeof loadSqlite()).toBe("function");
  });
});

describe("probeNativeBindings", () => {
  it("reports ok against the real binding", () => {
    expect(probeNativeBindings()).toEqual({
      module: "better-sqlite3",
      status: "ok",
    });
  });

  it("reports broken with the fix command -- and never throws", () => {
    const report = probeNativeBindings(() => {
      throw bindingsError("abi", "v26.0.0", "/plugin/cache");
    });
    expect(report.status).toBe("broken");
    expect(report.module).toBe("better-sqlite3");
    expect(report.kind).toBe("abi");
    expect(report.message).toContain("built for a different runtime");
    expect(report.fix).toBe(
      `${rebuildFix()}, then reload plugins (or restart the session) ` +
        "so the server picks up the new binding",
    );
  });
});

describe("MemoryIndex with a broken binding", () => {
  it("construction surfaces the typed error, not the raw loader stack", () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-native-"));
    try {
      let caught: unknown;
      try {
        new MemoryIndex(join(dir, "idx.db"), () => {
          throw new Error(RAW_BINDINGS_MSG);
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CairnError);
      expect((caught as CairnError).code).toBe("NATIVE_MODULE_BROKEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
