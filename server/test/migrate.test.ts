// SPI-level migration: local (temp dir) → FakeTracker as the hosted stand-in.
// The E4 probe dry-run, productionized.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FakeTracker } from "../src/tracker/fake.js";
import { finalizeMigration, migrateTracker } from "../src/tracker/migrate.js";
import { configSchema, make } from "../src/tracker/adapters/local.js";
import type { Tracker } from "../src/tracker/types.js";

/** Local store with one of everything worth carrying. */
async function seededLocal(): Promise<{ src: Tracker; ids: Record<string, string>; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cairn-mig-"));
  const src = make(configSchema.parse({ prefix: "lt" }), dir);
  const phase = await src.createPhase("Phase 1");
  const open = await src.createIssue({ title: "Open one", body: "body A", labels: ["x"], phase: phase.id });
  const done = await src.createIssue({ title: "Done one", labels: ["priority:P1"] });
  await src.updateIssue(done.id, { assignee: "jsreed" });
  await src.closeIssue(done.id);
  const talky = await src.createIssue({ title: "Talky" });
  await src.commentIssue(talky.id, "first note");
  await src.commentIssue(talky.id, "second note");
  await src.logWork!(talky.id, 25);
  await src.linkIssues!(open.id, "blocks", talky.id);
  return { src, ids: { phase: phase.id, open: open.id, done: done.id, talky: talky.id }, dir };
}

describe("migrateTracker", () => {
  it("carries phases, issues, states, labels, assignee, history, links — with remap + provenance", async () => {
    const { src, ids } = await seededLocal();
    const dst = new FakeTracker();
    const r = await migrateTracker(src, dst);

    expect(r.counts).toEqual({ phases: 1, issues: 3, comments: 2, worklogs: 1, links: 1 });
    expect(Object.keys(r.remap)).toHaveLength(3);
    expect(r.warnings).toEqual([]);

    const open = await dst.getIssue(r.remap[ids.open]);
    expect(open.title).toBe("Open one");
    expect(open.body).toContain("body A");
    expect(open.body).toContain(`[migrated from ${ids.open}]`);
    expect(open.phase).toBe(r.phaseRemap[ids.phase]);
    expect(open.labels).toEqual(["x"]);

    const done = await dst.getIssue(r.remap[ids.done]);
    expect(done.state).toBe("closed");
    expect(done.labels).toContain("priority:P1");
    expect(done.assignee).toBe("jsreed");

    const comments = await dst.listComments!(r.remap[ids.talky]);
    expect(comments.map((c) => c.text)).toEqual([
      expect.stringMatching(/^\[.+\] first note$/),
      expect.stringMatching(/^\[.+\] second note$/),
      expect.stringMatching(/^\[worklog .+\] 25m$/),   // Fake hasWorklog=false → comment fallback
    ]);

    // Fake has real links → native carry with remapped ids
    expect(await dst.listLinks!()).toContainEqual({
      from: r.remap[ids.open], type: "blocks", to: r.remap[ids.talky],
    });
    expect((await dst.listPhases()).map((p) => p.name)).toContain("Phase 1");
  });

  it("dst without link support → link degrades to a comment + warning", async () => {
    const { src, ids } = await seededLocal();
    const dst = new FakeTracker();
    (dst as { linkIssues?: unknown }).linkIssues = undefined;
    const r = await migrateTracker(src, dst);
    expect(r.warnings.some((w) => w.includes("link"))).toBe(true);
    const fromComments = await dst.listComments!(r.remap[ids.open]);
    expect(fromComments.some((c) => /^\[link\] blocks → /.test(c.text))).toBe(true);
  });

  it("finalizeMigration writes MIGRATED.json and marks config.json; store stays writable", async () => {
    const { src, dir } = await seededLocal();
    const dst = new FakeTracker();
    const r = await migrateTracker(src, dst);
    const storeDir = join(dir, ".tracker");
    const path = finalizeMigration(storeDir, "github", r);
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.target).toBe("github");
    expect(record.remap).toEqual(r.remap);
    expect(record.counts).toEqual(r.counts);
    const cfg = JSON.parse(readFileSync(join(storeDir, "config.json"), "utf8"));
    expect(cfg.migratedTo).toBe("github");
    // soft guard only — the store still accepts writes
    const after = await src.createIssue({ title: "post-migration write" });
    expect(after.id).toBeTruthy();
  });

  it("a per-item failure becomes a warning, not an abort", async () => {
    const { src } = await seededLocal();
    const dst = new FakeTracker();
    let failed = false;
    const real = dst.commentIssue.bind(dst);
    dst.commentIssue = async (id, text) => {
      if (!failed) { failed = true; throw new Error("flaky backend"); }
      return real(id, text);
    };
    const r = await migrateTracker(src, dst);
    expect(r.counts.issues).toBe(3);
    expect(r.warnings.some((w) => w.includes("flaky backend"))).toBe(true);
  });
});
