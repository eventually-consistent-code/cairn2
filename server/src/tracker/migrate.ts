// SPI-level tracker migration — promote a project's issues from one backend
// to another (local → hosted is the designed direction, but nothing here is
// local-specific). Order matters: phases first, then issues (phase refs
// remapped), then history, then links. Per-item failures become warnings —
// a half-migrated target is reported honestly, never hidden behind an abort.
// Known cosmetic limit (spec'd): hosted comment APIs attribute writes to the
// API credential, so original author/time survive as a text prefix.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tracker } from "./types.js";

export interface MigrateResult {
  /** old issue id → new issue id */
  remap: Record<string, string>;
  phaseRemap: Record<string, string>;
  counts: { phases: number; issues: number; comments: number; worklogs: number; links: number };
  warnings: string[];
}

/**
 * Post-migration bookkeeping on the LOCAL store: write MIGRATED.json (the
 * durable remap record) and mark config.json migratedTo. The only mutation
 * migration ever makes to the source. Returns the record's path.
 */
export function finalizeMigration(storeDir: string, targetType: string,
  result: MigrateResult): string {
  const path = join(storeDir, "MIGRATED.json");
  writeFileSync(path, `${JSON.stringify({
    target: targetType,
    remap: result.remap,
    phaseRemap: result.phaseRemap,
    counts: result.counts,
    warnings: result.warnings,
    at: new Date().toISOString(),
  }, null, 2)}\n`);
  const cfgPath = join(storeDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(cfgPath, `${JSON.stringify({ ...cfg, migratedTo: targetType }, null, 2)}\n`);
  return path;
}

export async function migrateTracker(src: Tracker, dst: Tracker): Promise<MigrateResult> {
  const remap: Record<string, string> = {};
  const phaseRemap: Record<string, string> = {};
  const counts = { phases: 0, issues: 0, comments: 0, worklogs: 0, links: 0 };
  const warnings: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    try { await fn(); return true; } catch (e) {
      warnings.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  // Phases — containers first so issues can land inside them.
  for (const p of await src.listPhases()) {
    await attempt(`phase '${p.name}'`, async () => {
      const created = await dst.createPhase(p.name);
      phaseRemap[p.id] = created.id;
      counts.phases++;
      if (p.state === "closed" && dst.capabilities.hasPhaseClose) {
        await dst.closePhase(created.id);
      }
    });
  }

  // Issues — body gains the provenance backlink; state/assignee follow.
  const issues = await src.listIssues();
  for (const i of issues) {
    await attempt(`issue '${i.id}'`, async () => {
      const made = await dst.createIssue({
        title: i.title,
        body: `${i.body}${i.body ? "\n\n" : ""}[migrated from ${i.id}]`,
        labels: i.labels,
        phase: i.phase ? phaseRemap[i.phase] : undefined,
        estimate: i.estimate,
      });
      remap[i.id] = made.id;
      counts.issues++;
      if (i.state !== "open") await dst.updateIssue(made.id, { state: i.state });
      if (i.assignee) {
        await attempt(`assignee on '${i.id}'`,
          () => dst.updateIssue(made.id, { assignee: i.assignee }).then(() => undefined));
      }
    });
  }

  // History — original author/time survive inside the text.
  for (const i of issues) {
    const newId = remap[i.id];
    if (!newId) continue;
    for (const c of await src.listComments?.(i.id) ?? []) {
      const prefix = c.at || c.author ? `[${c.at ?? "?"} ${c.author ?? "?"}] ` : "";
      if (await attempt(`comment on '${i.id}'`,
        () => dst.commentIssue(newId, `${prefix}${c.text}`).then(() => undefined))) {
        counts.comments++;
      }
    }
    for (const w of await src.listWorklogs?.(i.id) ?? []) {
      const carried = dst.capabilities.hasWorklog && dst.logWork
        ? () => dst.logWork!(newId, w.minutes)
        : () => dst.commentIssue(newId,
          `[worklog ${w.at ?? "?"} ${w.author ?? "?"}] ${w.minutes}m`).then(() => undefined);
      if (await attempt(`worklog on '${i.id}'`, carried)) counts.worklogs++;
    }
  }

  // Links — native when the target speaks them, comment backlink otherwise.
  for (const l of await src.listLinks?.() ?? []) {
    const from = remap[l.from];
    const to = remap[l.to];
    if (!from || !to) {
      warnings.push(`link ${l.from} ${l.type} ${l.to}: endpoint not migrated`);
      continue;
    }
    if (dst.linkIssues) {
      if (await attempt(`link ${l.from} ${l.type} ${l.to}`,
        () => dst.linkIssues!(from, l.type, to))) counts.links++;
    } else {
      warnings.push(`link ${l.from} ${l.type} ${l.to}: target has no link support — recorded as a comment`);
      if (await attempt(`link comment on '${l.from}'`,
        () => dst.commentIssue(from, `[link] ${l.type} → ${to}`).then(() => undefined))) {
        counts.links++;
      }
    }
  }

  return { remap, phaseRemap, counts, warnings };
}
