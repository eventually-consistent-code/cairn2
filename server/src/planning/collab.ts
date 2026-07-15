import type { Issue, Tracker } from "../tracker/types.js";
import { projectStatus } from "./status.js";

export async function unplannedReport(
  tracker: Tracker, projectDir: string,
): Promise<{ unplanned: Issue[]; referencedCount: number }> {
  const referenced = new Set(
    projectStatus(projectDir).phases.flatMap((p) => p.issues));
  // No state filter on the fetch: listIssues' state filter is exact-match,
  // and an unreferenced in_progress issue must still surface. Exclude only closed.
  const all = await tracker.listIssues();
  const open = all.filter((i) => i.state !== "closed");
  return {
    unplanned: open.filter((i) => !referenced.has(i.id)),
    referencedCount: referenced.size,
  };
}
