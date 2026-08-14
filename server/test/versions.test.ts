// Installed-version visibility (#82): the pieces config_probe's versions
// section is assembled from. Every input degrades independently -- a missing
// file is null, an unreachable registry is "unknown", and nothing throws.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNKNOWN, driftLines, fetchNpmLatest, installedVersions,
  pluginCacheVersion, repoVersions,
} from "../src/core/versions.js";

const dirs: string[] = [];
function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Lays down the cairn repo's three version files in a temp dir. */
function fakeRepo(versions: { root?: string; server?: string; plugin?: string }): string {
  const d = fresh("cairn-versions-");
  mkdirSync(join(d, ".claude-plugin"), { recursive: true });
  mkdirSync(join(d, "server"), { recursive: true });
  if (versions.root) writeFileSync(join(d, "package.json"), JSON.stringify({ version: versions.root }));
  writeFileSync(join(d, "server", "package.json"), JSON.stringify({ version: versions.server ?? "0.0.0" }));
  writeFileSync(join(d, ".claude-plugin", "plugin.json"), JSON.stringify({ version: versions.plugin ?? "0.0.0" }));
  return d;
}

describe("pluginCacheVersion", () => {
  it("parses the version segment out of a plugin cache path", () => {
    const p = "/Users/x/.claude/plugins/cache/eventually-consistent/cairn/2.1.0/server/dist/index.js";
    expect(pluginCacheVersion(p)).toBe("2.1.0");
  });

  it("is null for a path outside any plugins/cache tree (dev clone, npx)", () => {
    expect(pluginCacheVersion("/Users/x/repos/cairn2/server/dist/index.js")).toBeNull();
    expect(pluginCacheVersion("/tmp/npx-123/node_modules/@eventually-consistent/cairn-server/dist/index.js")).toBeNull();
  });
});

describe("repoVersions", () => {
  it("reads all three version files when the project dir is the cairn repo", () => {
    const d = fakeRepo({ root: "2.2.0", server: "2.2.0", plugin: "2.2.0" });
    expect(repoVersions(d)).toEqual({ root: "2.2.0", server: "2.2.0", plugin: "2.2.0" });
  });

  it("is null for a project dir that isn't the cairn repo", () => {
    expect(repoVersions(fresh("cairn-notrepo-"))).toBeNull();
  });

  it("an unreadable individual file degrades to null, not an error", () => {
    const d = fakeRepo({ server: "2.2.0", plugin: "2.2.0" }); // no root package.json
    expect(repoVersions(d)).toEqual({ root: null, server: "2.2.0", plugin: "2.2.0" });
  });
});

describe("fetchNpmLatest (fail-soft by contract)", () => {
  it("returns the published version on a good response", async () => {
    const fake = (async () => ({ ok: true, json: async () => ({ version: "2.3.0" }) })) as unknown as typeof fetch;
    expect(await fetchNpmLatest(fake)).toBe("2.3.0");
  });

  it("non-2xx, throwing, and versionless responses all collapse to 'unknown'", async () => {
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const boom = (async () => { throw new Error("ENOTFOUND registry.npmjs.org"); }) as unknown as typeof fetch;
    const empty = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchNpmLatest(bad)).toBe(UNKNOWN);
    expect(await fetchNpmLatest(boom)).toBe(UNKNOWN);
    expect(await fetchNpmLatest(empty)).toBe(UNKNOWN);
  });
});

describe("driftLines", () => {
  it("everything agreeing produces no drift", () => {
    expect(driftLines({
      server: "2.2.0", pluginCache: "2.2.0",
      repo: { root: "2.2.0", server: "2.2.0", plugin: "2.2.0" }, npmLatest: "2.2.0",
    })).toEqual([]);
  });

  it("an unknown registry is silence, never a drift line", () => {
    expect(driftLines({ server: "2.2.0", pluginCache: null, repo: null, npmLatest: UNKNOWN }))
      .toEqual([]);
  });

  it("npm ahead of the install surfaces the plain-language line", () => {
    const lines = driftLines({ server: "2.2.0", pluginCache: null, repo: null, npmLatest: "2.3.0" });
    expect(lines.some((l) => l.includes("installed v2.2.0, available v2.3.0"))).toBe(true);
  });

  it("a stale plugin cache path and a diverged dev repo each get their own line", () => {
    const lines = driftLines({
      server: "2.2.0", pluginCache: "2.1.0",
      repo: { root: "2.3.0", server: "2.3.0", plugin: "2.3.0" }, npmLatest: UNKNOWN,
    });
    expect(lines.some((l) => l.includes("plugin cache path says v2.1.0"))).toBe(true);
    expect(lines.some((l) => l.includes("running v2.2.0, repo v2.3.0"))).toBe(true);
  });

  it("disagreeing repo version files trip the release-gate line", () => {
    const lines = driftLines({
      server: "2.2.0", pluginCache: null,
      repo: { root: "2.2.0", server: "2.2.0", plugin: "2.1.0" }, npmLatest: UNKNOWN,
    });
    expect(lines.some((l) => l.includes("repo version files disagree"))).toBe(true);
  });
});

describe("installedVersions", () => {
  it("assembles the report and a rejecting fetchLatest degrades to 'unknown'", async () => {
    const d = fakeRepo({ root: "2.2.0", server: "2.2.0", plugin: "2.2.0" });
    const v = await installedVersions({
      serverVersion: "2.2.0",
      modulePath: "/Users/x/.claude/plugins/cache/mkt/cairn/2.2.0/server/dist/index.js",
      projectDir: d,
      fetchLatest: async () => { throw new Error("offline"); },
    });
    expect(v).toEqual({
      server: "2.2.0", pluginCache: "2.2.0",
      repo: { root: "2.2.0", server: "2.2.0", plugin: "2.2.0" },
      npmLatest: UNKNOWN, drift: [],
    });
  });
});
