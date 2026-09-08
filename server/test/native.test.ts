// Native-binding safeguard tests (#108) -- all failure paths are simulated
// via the injectable loader/require seams, never by breaking the real
// compiled binding.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CairnError } from "../src/errors.js";
import {
  bindingsError,
  isBindingsFailure,
  loadSqlite,
  probeNativeBindings,
  rebuildFix,
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

describe("serverDir / rebuildFix", () => {
  it("resolves the real server package dir (holds package.json)", () => {
    const d = serverDir();
    expect(d.endsWith("server")).toBe(true);
  });

  it("rebuildFix names the exact command against that dir", () => {
    expect(rebuildFix()).toBe(`cd ${serverDir()} && npm rebuild better-sqlite3`);
  });
});

describe("bindingsError", () => {
  it("is a typed NATIVE_MODULE_BROKEN naming runtime and fix", () => {
    const e = bindingsError("v26.0.0", "/plugin/cache/server");
    expect(e).toBeInstanceOf(CairnError);
    expect(e.code).toBe("NATIVE_MODULE_BROKEN");
    expect(e.message).toBe(
      "native module better-sqlite3 not built for this runtime (node v26.0.0); " +
        "run: cd /plugin/cache/server && npm rebuild better-sqlite3",
    );
    expect(e.nextAction).toContain("rebuild once, then retry");
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
      throw bindingsError("v26.0.0", "/plugin/cache/server");
    });
    expect(report.status).toBe("broken");
    expect(report.module).toBe("better-sqlite3");
    expect(report.message).toContain("not built for this runtime");
    expect(report.fix).toBe(rebuildFix());
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
