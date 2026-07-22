import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CairnError } from "../src/errors.js";
import { findWorkspace, resolveProjectDir, setFocus } from "../src/workspace/context.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-workspace-"));

function writeWorkspace(root: string, workspace: string, members: Array<{ name: string; path: string }>): void {
  writeFileSync(join(root, "cairn-workspace.json"), JSON.stringify({ workspace, members }, null, 2));
}

function configureMember(root: string, relPath: string): void {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cairn.json"), JSON.stringify({ tracker: { type: "github", config: {} } }));
}

describe("findWorkspace", () => {
  it("finds a workspace at the launch dir itself", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const info = findWorkspace(root);
    expect(info?.workspace).toBe("acme");
    expect(info?.root).toBe(root);
    expect(info?.members).toEqual([{ name: "api", path: "api", absPath: join(root, "api"), configured: true }]);
    expect(info?.focus).toBeNull();
  });

  it("walks up two levels to find the workspace root", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const nested = join(root, "api", "src", "deep");
    mkdirSync(nested, { recursive: true });
    const info = findWorkspace(nested);
    expect(info?.root).toBe(root);
    expect(info?.workspace).toBe("acme");
  });

  it("returns null when no workspace file exists up to the filesystem root", () => {
    const dir = fresh();
    expect(findWorkspace(dir)).toBeNull();
  });

  it("lists a member without cairn.json as unconfigured", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "web", path: "web" }]);
    mkdirSync(join(root, "web"), { recursive: true });
    const info = findWorkspace(root)!;
    expect(info.members[0]).toEqual({ name: "web", path: "web", absPath: join(root, "web"), configured: false });
  });

  it("throws CONFIG_INVALID for malformed workspace JSON rather than falling back to no-workspace", () => {
    const root = fresh();
    writeFileSync(join(root, "cairn-workspace.json"), "{ not valid json");
    expect(() => findWorkspace(root)).toThrow(CairnError);
    try {
      findWorkspace(root);
      throw new Error("expected findWorkspace to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
      expect((e as CairnError).message).toContain("cairn-workspace.json");
    }
  });

  it("throws CONFIG_INVALID when workspace JSON is missing required fields", () => {
    const root = fresh();
    writeFileSync(join(root, "cairn-workspace.json"), JSON.stringify({ foo: "bar" }));
    expect(() => findWorkspace(root)).toThrow(CairnError);
    try {
      findWorkspace(root);
    } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });
});

describe("setFocus + resolveProjectDir", () => {
  it("round-trips: setFocus writes focus, resolveProjectDir follows it", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const result = setFocus(root, "api");
    expect(result).toEqual({ focus: "api", projectDir: join(root, "api") });
    expect(resolveProjectDir(root)).toBe(join(root, "api"));
  });

  it("rejects focusing an unconfigured member, naming it and the fix", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "web", path: "web" }]);
    mkdirSync(join(root, "web"), { recursive: true });
    try {
      setFocus(root, "web");
      throw new Error("expected setFocus to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
      expect((e as CairnError).message).toContain("web");
      expect((e as CairnError).nextAction ?? "").toContain("cairn.json");
    }
  });

  it("rejects focusing a name that is not a member", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    try {
      setFocus(root, "ghost");
      throw new Error("expected setFocus to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
      expect((e as CairnError).message).toContain("not a member");
      expect((e as CairnError).message).toContain("acme");
    }
  });

  it("clears focus with null; resolution falls back to the launch dir", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    const cleared = setFocus(root, null);
    expect(cleared).toEqual({ focus: null, projectDir: root });
    expect(resolveProjectDir(root)).toBe(root);
  });

  it("resolves to the launch dir when there is no workspace at all (compat path)", () => {
    const dir = fresh();
    expect(resolveProjectDir(dir)).toBe(dir);
  });

  it("resolves to the launch dir when a workspace exists but no focus is set", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    expect(resolveProjectDir(root)).toBe(root);
  });

  it("resolves to the exact launch dir (not the workspace root) when unfocused, even nested inside a member", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const nested = join(root, "api", "src");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectDir(nested)).toBe(nested);
  });

  it("throws CONFIG_INVALID when the focused member is removed from the workspace file (stale focus)", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    writeWorkspace(root, "acme", []);
    expect(() => resolveProjectDir(root)).toThrow(CairnError);
    try {
      resolveProjectDir(root);
    } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("throws CONFIG_INVALID when the focused member becomes unconfigured (cairn.json removed)", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    rmSync(join(root, "api", "cairn.json"));
    expect(() => resolveProjectDir(root)).toThrow(CairnError);
    try {
      resolveProjectDir(root);
    } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("writes the focus file atomically under .cairn/basecamp/focus.json at the workspace root", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    const info = findWorkspace(root);
    expect(info?.focus).toBe("api");
  });
});
