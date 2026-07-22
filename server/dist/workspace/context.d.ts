export interface WorkspaceMember {
    name: string;
    path: string;
    configured: boolean;
    absPath: string;
}
export interface WorkspaceInfo {
    workspace: string;
    root: string;
    members: WorkspaceMember[];
    focus: string | null;
}
/**
 * Walks up from `launchDir` looking for `cairn-workspace.json`, stopping at the
 * filesystem root (no `.git` requirement — see spec). Returns null when none is
 * found. A workspace file that exists but is malformed (bad JSON or missing the
 * expected shape) is NEVER treated as "no workspace" — that would silently fall
 * back to single-project behavior on a typo'd file, which is the trap this spec
 * calls out explicitly. It throws CONFIG_INVALID naming the file instead.
 */
export declare function findWorkspace(launchDir: string): WorkspaceInfo | null;
/**
 * Sets (or clears, with `project: null`) the workspace focus. Validates the
 * target is a real, configured member before writing — an unconfigured or
 * unknown member is rejected with CONFIG_INVALID naming the member and the fix,
 * never silently accepted. Write is atomic (tmp + rename).
 */
export declare function setFocus(launchDir: string, project: string | null): {
    focus: string | null;
    projectDir: string;
};
/**
 * The one function every tool call resolves its project dir through. No
 * workspace, or a workspace with no focus set, both resolve to `launchDir`
 * itself — the compatibility path that keeps single-project behavior
 * byte-identical. A focus naming a member that has since vanished or lost its
 * cairn.json is a stale-focus error, never a silent fallback to launchDir.
 */
export declare function resolveProjectDir(launchDir: string): string;
