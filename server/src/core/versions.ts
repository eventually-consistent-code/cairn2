// Installed-version visibility (#82) -- one answer to "what version is
// running where". Four release-integrity incidents shared that single blind
// spot, so config_probe now reports it in one place: the running server's own
// version, the plugin cache entry it executes from (parsed off its own module
// path), the repo's three version files when the project dir IS the cairn
// repo (dev-vs-installed drift), and the latest published npm version.
//
// The npm lookup is a network call, so it fails SOFT by design: an
// unreachable registry produces "unknown", never an error -- version
// visibility must not make the preflight flaky.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The published package the server ships as -- what the npm lookup asks about. */
export const NPM_PACKAGE = "@eventually-consistent/cairn-server";

/** Sentinel for "the registry didn't answer usably" -- soft, never a throw. */
export const UNKNOWN = "unknown";

export interface RepoVersions {
  root: string | null;
  server: string | null;
  plugin: string | null;
}

export interface InstalledVersions {
  /** The running server's own version (serverInfo reads the same source). */
  server: string;
  /** Version segment of the plugin cache path this process runs from, or null when not cache-installed. */
  pluginCache: string | null;
  /** The repo's three version files, only when the project dir is the cairn repo itself. */
  repo: RepoVersions | null;
  /** Latest published npm version, or "unknown" when the registry is unreachable. */
  npmLatest: string;
  /** Plain-language drift lines -- empty means everything agrees. */
  drift: string[];
}

// Reads a version field out of a JSON file; any failure (missing file, bad
// JSON, no version key) is null -- callers render null as "absent", not error.
function readVersionFile(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Parses the plugin-cache version out of a module path. Claude Code installs
 *  plugins under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/...,
 *  so a server running from there knows its installed version from its own
 *  location. Any path not under a plugins/cache tree is null. */
export function pluginCacheVersion(modulePath: string): string | null {
  const m = /[/\\]plugins[/\\]cache[/\\][^/\\]+[/\\][^/\\]+[/\\]([^/\\]+)[/\\]/.exec(modulePath);
  return m ? m[1] : null;
}

/** The repo's three version files -- only meaningful when the project dir is
 *  the cairn repo itself (detected by its plugin manifest + server package
 *  living where cairn keeps them). Any other project dir is null. */
export function repoVersions(projectDir: string): RepoVersions | null {
  if (!existsSync(join(projectDir, ".claude-plugin", "plugin.json"))
      || !existsSync(join(projectDir, "server", "package.json"))) {
    return null;
  }
  return {
    root: readVersionFile(join(projectDir, "package.json")),
    server: readVersionFile(join(projectDir, "server", "package.json")),
    plugin: readVersionFile(join(projectDir, ".claude-plugin", "plugin.json")),
  };
}

/** Latest published version from the npm registry. Fails soft: timeout, DNS
 *  failure, non-2xx, and unparseable bodies all collapse to "unknown". */
export async function fetchNpmLatest(
  fetchImpl: typeof fetch = fetch, timeoutMs = 2500,
): Promise<string> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const url = `https://registry.npmjs.org/${NPM_PACKAGE.replace("/", "%2f")}/latest`;
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) return UNKNOWN;
      const body = await res.json() as { version?: unknown };
      return typeof body.version === "string" ? body.version : UNKNOWN;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return UNKNOWN;
  }
}

/** Plain-language drift report -- each line names the disagreement and what to
 *  do about it. Empty array means every visible version agrees. */
export function driftLines(v: Omit<InstalledVersions, "drift">): string[] {
  const lines: string[] = [];
  if (v.npmLatest !== UNKNOWN && v.npmLatest !== v.server) {
    lines.push(`installed v${v.server}, available v${v.npmLatest} -- update the plugin (or npm install) to adopt`);
  }
  if (v.pluginCache && v.pluginCache !== v.server) {
    lines.push(`plugin cache path says v${v.pluginCache} but the server reports v${v.server} -- stale cache entry, reinstall the plugin`);
  }
  if (v.repo) {
    if (v.repo.server && v.repo.server !== v.server) {
      lines.push(`running v${v.server}, repo v${v.repo.server} -- this dev tree is not what's running; rebuild/reinstall to align`);
    }
    const named = [v.repo.root, v.repo.server, v.repo.plugin]
      .filter((x): x is string => x !== null);
    if (new Set(named).size > 1) {
      lines.push(`repo version files disagree (root v${v.repo.root}, server v${v.repo.server}, plugin v${v.repo.plugin}) -- the release gate checks all three`);
    }
  }
  return lines;
}

/** Assembles the full installed-versions report for config_probe. Never
 *  throws: every input degrades independently (null / "unknown"). */
export async function installedVersions(opts: {
  serverVersion: string;
  modulePath: string;
  projectDir: string;
  fetchLatest?: () => Promise<string>;
}): Promise<InstalledVersions> {
  const npmLatest = await (opts.fetchLatest
    ? opts.fetchLatest().catch(() => UNKNOWN)
    : fetchNpmLatest());
  const base = {
    server: opts.serverVersion,
    pluginCache: pluginCacheVersion(opts.modulePath),
    repo: repoVersions(opts.projectDir),
    npmLatest,
  };
  return { ...base, drift: driftLines(base) };
}
