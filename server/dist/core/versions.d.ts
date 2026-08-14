/** The published package the server ships as -- what the npm lookup asks about. */
export declare const NPM_PACKAGE = "@eventually-consistent/cairn-server";
/** Sentinel for "the registry didn't answer usably" -- soft, never a throw. */
export declare const UNKNOWN = "unknown";
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
/** Parses the plugin-cache version out of a module path. Claude Code installs
 *  plugins under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/...,
 *  so a server running from there knows its installed version from its own
 *  location. Any path not under a plugins/cache tree is null. */
export declare function pluginCacheVersion(modulePath: string): string | null;
/** The repo's three version files -- only meaningful when the project dir is
 *  the cairn repo itself (detected by its plugin manifest + server package
 *  living where cairn keeps them). Any other project dir is null. */
export declare function repoVersions(projectDir: string): RepoVersions | null;
/** Latest published version from the npm registry. Fails soft: timeout, DNS
 *  failure, non-2xx, and unparseable bodies all collapse to "unknown". */
export declare function fetchNpmLatest(fetchImpl?: typeof fetch, timeoutMs?: number): Promise<string>;
/** Plain-language drift report -- each line names the disagreement and what to
 *  do about it. Empty array means every visible version agrees. */
export declare function driftLines(v: Omit<InstalledVersions, "drift">): string[];
/** Assembles the full installed-versions report for config_probe. Never
 *  throws: every input degrades independently (null / "unknown"). */
export declare function installedVersions(opts: {
    serverVersion: string;
    modulePath: string;
    projectDir: string;
    fetchLatest?: () => Promise<string>;
}): Promise<InstalledVersions>;
