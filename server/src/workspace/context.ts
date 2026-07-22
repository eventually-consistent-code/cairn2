import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";

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

const WORKSPACE_FILE = "cairn-workspace.json";
const focusPath = (root: string) => join(root, ".cairn", "basecamp", "focus.json");

/** Reads the workspace-root focus file. Absent file means no focus (never an error). */
function readFocus(root: string): string | null {
  const path = focusPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `${path} is not valid JSON: ${e}`,
      "inspect or delete .cairn/basecamp/focus.json");
  }
  const focus = (parsed as { focus?: unknown } | null)?.focus;
  return typeof focus === "string" ? focus : null;
}

function writeFocus(root: string, focus: string | null): void {
  const path = focusPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ focus }, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Walks up from `launchDir` looking for `cairn-workspace.json`, stopping at the
 * filesystem root (no `.git` requirement — see spec). Returns null when none is
 * found. A workspace file that exists but is malformed (bad JSON or missing the
 * expected shape) is NEVER treated as "no workspace" — that would silently fall
 * back to single-project behavior on a typo'd file, which is the trap this spec
 * calls out explicitly. It throws CONFIG_INVALID naming the file instead.
 */
export function findWorkspace(launchDir: string): WorkspaceInfo | null {
  let dir = resolve(launchDir);
  for (;;) {
    const path = join(dir, WORKSPACE_FILE);
    if (existsSync(path)) return loadWorkspace(path, dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadWorkspace(path: string, root: string): WorkspaceInfo {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `${path} could not be read: ${e}`,
      `fix or remove ${WORKSPACE_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `${path} is not valid JSON: ${e}`,
      `fix or remove ${WORKSPACE_FILE}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CairnError("CONFIG_INVALID", `${path} must contain a JSON object`,
      `fix ${WORKSPACE_FILE} — expected { workspace, members }`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.workspace !== "string" || obj.workspace.trim().length === 0 || !Array.isArray(obj.members)) {
    throw new CairnError("CONFIG_INVALID",
      `${path} is missing a 'workspace' name or a 'members' array`,
      `fix ${WORKSPACE_FILE} — expected { workspace: string, members: [{ name, path }] }`);
  }
  const members: WorkspaceMember[] = obj.members.map((raw, i) => {
    if (typeof raw !== "object" || raw === null
      || typeof (raw as Record<string, unknown>).name !== "string"
      || typeof (raw as Record<string, unknown>).path !== "string") {
      throw new CairnError("CONFIG_INVALID", `${path}: member ${i} is missing 'name' or 'path'`,
        `fix ${WORKSPACE_FILE} — every member needs a name and a path`);
    }
    const m = raw as { name: string; path: string };
    const absPath = resolve(root, m.path);
    return { name: m.name, path: m.path, absPath, configured: existsSync(join(absPath, "cairn.json")) };
  });
  return { workspace: obj.workspace, root, members, focus: readFocus(root) };
}

/**
 * Sets (or clears, with `project: null`) the workspace focus. Validates the
 * target is a real, configured member before writing — an unconfigured or
 * unknown member is rejected with CONFIG_INVALID naming the member and the fix,
 * never silently accepted. Write is atomic (tmp + rename).
 */
export function setFocus(launchDir: string, project: string | null):
  { focus: string | null; projectDir: string } {
  const info = findWorkspace(launchDir);
  if (!info) {
    throw new CairnError("PRECONDITION_FAILED", `no workspace found from ${launchDir}`,
      "run basecamp init");
  }
  if (project === null) {
    writeFocus(info.root, null);
    return { focus: null, projectDir: launchDir };
  }
  const member = info.members.find((m) => m.name === project);
  if (!member) {
    throw new CairnError("CONFIG_INVALID", `'${project}' is not a member of workspace '${info.workspace}'`,
      `known members: ${info.members.map((m) => m.name).join(", ") || "(none)"}`);
  }
  if (!member.configured) {
    throw new CairnError("CONFIG_INVALID", `member '${project}' has no cairn.json and cannot be focused`,
      `add a cairn.json to ${member.path}`);
  }
  writeFocus(info.root, project);
  return { focus: project, projectDir: member.absPath };
}

/**
 * The one function every tool call resolves its project dir through. No
 * workspace, or a workspace with no focus set, both resolve to `launchDir`
 * itself — the compatibility path that keeps single-project behavior
 * byte-identical. A focus naming a member that has since vanished or lost its
 * cairn.json is a stale-focus error, never a silent fallback to launchDir.
 */
export function resolveProjectDir(launchDir: string): string {
  const info = findWorkspace(launchDir);
  if (!info || info.focus === null) return launchDir;
  const member = info.members.find((m) => m.name === info.focus);
  if (!member || !member.configured) {
    throw new CairnError("CONFIG_INVALID",
      `focus names '${info.focus}' but it is ${member ? "no longer configured (missing cairn.json)"
        : "no longer a member"} of workspace '${info.workspace}'`,
      `clear focus (workspace_focus with project: null) or restore '${info.focus}' as a configured member`);
  }
  return member.absPath;
}
