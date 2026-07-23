import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CairnError } from "../errors.js";
import type { Issue, IssueState, Phase, Tracker } from "../tracker/types.js";

interface IssueSnap {
  title: string;
  bodyHash: string;
  labels: string[];
  assignee?: string;
  state: IssueState;
  updatedAt: string;
}

interface Marker {
  lastScan: string;
  issues: Record<string, IssueSnap>;
  phases: Record<string, string>; // id -> name
}

export interface FieldChange {
  field: "title" | "body" | "labels" | "assignee";
  from?: string;
  to?: string;
}
export interface EditedItem { issue: Issue; changes: FieldChange[] }
export interface StateChange { issue: Issue; from: IssueState; to: IssueState }
export interface TrackerDeltaReport {
  initialized: boolean;
  new: Issue[];
  newPhases: Phase[];
  edited: EditedItem[];
  stateChanged: StateChange[];
}

export const markerPath = (projectDir: string) =>
  join(projectDir, ".cairn", "tracker-marker.json");

const bodyHash = (body: string) =>
  createHash("sha256").update(body).digest("hex").slice(0, 16);

const snap = (i: Issue): IssueSnap => ({
  title: i.title, bodyHash: bodyHash(i.body), labels: [...i.labels].sort(),
  assignee: i.assignee, state: i.state, updatedAt: i.updatedAt,
});

const readMarker = (projectDir: string): Marker | null => {
  const p = markerPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Marker;
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `tracker marker at ${p} is not valid JSON: ${e}`,
      "delete the marker file to re-initialize");
  }
};

const writeMarker = (projectDir: string, m: Marker) => {
  const p = markerPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(tmp, p);
};

/** Absorb a cairn-side mutation so it never echoes as an external change.
 *  Silent no-op before the first scan initializes the marker or if marker is corrupt. */
export function snapshotNote(projectDir: string, issue: Issue): void {
  let m: Marker | null;
  try {
    m = readMarker(projectDir);
  } catch {
    return; // silent no-op on corrupt marker
  }
  if (!m) return;
  m.issues[issue.id] = snap(issue);
  writeMarker(projectDir, m);
}

export async function trackerDelta(
  projectDir: string,
  tracker: Tracker,
  opts: { ack?: boolean } = {},
): Promise<TrackerDeltaReport> {
  const [issues, phases] = await Promise.all([
    tracker.listIssues(),
    tracker.capabilities.hasPhases ? tracker.listPhases() : Promise.resolve([]),
  ]);

  const next: Marker = {
    lastScan: new Date().toISOString(),
    issues: Object.fromEntries(issues.map((i) => [i.id, snap(i)])),
    phases: Object.fromEntries(phases.map((p) => [p.id, p.name])),
  };

  const prev = readMarker(projectDir);
  if (!prev) {
    writeMarker(projectDir, next);
    return { initialized: true, new: [], newPhases: [], edited: [], stateChanged: [] };
  }

  const added: Issue[] = [];
  const edited: EditedItem[] = [];
  const stateChanged: StateChange[] = [];

  for (const i of issues) {
    const old = prev.issues[i.id];
    if (!old) { added.push(i); continue; }
    if (old.state !== i.state) stateChanged.push({ issue: i, from: old.state, to: i.state });
    const changes: FieldChange[] = [];
    if (old.title !== i.title) changes.push({ field: "title", from: old.title, to: i.title });
    if (old.bodyHash !== bodyHash(i.body)) changes.push({ field: "body" });
    if (old.labels.join(" ") !== [...i.labels].sort().join(" "))
      changes.push({ field: "labels", from: old.labels.join(" "), to: [...i.labels].sort().join(" ") });
    if ((old.assignee ?? "") !== (i.assignee ?? ""))
      changes.push({ field: "assignee", from: old.assignee, to: i.assignee });
    if (changes.length) edited.push({ issue: i, changes });
  }

  const newPhases = phases.filter((p) => !(p.id in prev.phases));

  if (opts.ack) writeMarker(projectDir, next);

  return { initialized: false, new: added, newPhases, edited, stateChanged };
}
