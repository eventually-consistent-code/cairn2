import { describe, it, expect, beforeAll } from "vitest";
import type { Tracker } from "../src/tracker/types.js";

/** Retry an async assertion block until it passes or the deadline hits (live backends are eventually consistent). */
async function eventually<T>(fn: () => Promise<T>, timeoutMs = 15_000, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** Behavioral contract every cairn tracker adapter must satisfy. */
export function trackerContract(name: string, factory: () => Promise<Tracker>): void {
  describe(`tracker contract: ${name}`, () => {
    let t: Tracker;
    beforeAll(async () => { t = await factory(); });

    it("create → get roundtrip preserves title/body/labels, state=open", async () => {
      const made = await t.createIssue({
        title: "contract: roundtrip", body: "b1", labels: ["cairn-test"],
      });
      expect(made.id).toBeTruthy();
      const got = await t.getIssue(made.id);
      expect(got.title).toBe("contract: roundtrip");
      expect(got.body).toContain("b1");
      expect(got.category).toBe("open");
      expect(typeof got.state).toBe("string");
      expect(got.state.length).toBeGreaterThan(0);
      if (t.capabilities.hasLabels) expect(got.labels).toContain("cairn-test");
    });

    it("update changes title and body without clobbering unpatched fields", async () => {
      const made = await t.createIssue({
        title: "contract: update", body: "old", labels: ["keep-me"],
      });
      await t.updateIssue(made.id, { title: "contract: updated", body: "new" });
      const got = await t.getIssue(made.id);
      expect(got.title).toBe("contract: updated");
      expect(got.body).toContain("new");
      if (t.capabilities.hasLabels) expect(got.labels).toContain("keep-me");
    });

    it("in_progress maps per capabilities and reads back", async () => {
      const made = await t.createIssue({ title: "contract: wip" });
      await t.updateIssue(made.id, { state: "in_progress" });
      const got = await t.getIssue(made.id);
      if (t.capabilities.hasInProgress) expect(got.category).toBe("in_progress");
      else expect(got.category).toBe("open"); // degraded but never 'closed'
    });

    it("in_progress → open transition reads back open", async () => {
      if (!t.capabilities.hasInProgress) return;
      const made = await t.createIssue({ title: "contract: wip-return" });
      await t.updateIssue(made.id, { state: "in_progress" });
      await t.updateIssue(made.id, { state: "open" });
      await eventually(async () => {
        expect((await t.getIssue(made.id)).category).toBe("open");
      });
    }, 30_000);

    it("closed → open transition reads back open (reopen)", async () => {
      const made = await t.createIssue({ title: "contract: reopen" });
      await t.closeIssue(made.id);
      await t.updateIssue(made.id, { state: "open" });
      await eventually(async () => {
        expect((await t.getIssue(made.id)).category).toBe("open");
      });
    }, 30_000);

    it("close is effective and idempotent", async () => {
      const made = await t.createIssue({ title: "contract: close" });
      await t.closeIssue(made.id);
      await t.closeIssue(made.id); // second close must not throw
      expect((await t.getIssue(made.id)).category).toBe("closed");
    });

    it("phase create + assignment + list filter", async () => {
      if (!t.capabilities.hasPhases) return;
      const ph = await t.createPhase(`contract-phase-${Date.now()}`);
      const inPhase = await t.createIssue({ title: "contract: phased", phase: ph.id });
      const outOfPhase = await t.createIssue({ title: "contract: unphased" });
      await eventually(async () => {
        const listed = await t.listIssues({ phase: ph.id });
        const ids = listed.map((i) => i.id);
        expect(ids).toContain(inPhase.id);
        expect(ids).not.toContain(outOfPhase.id);
        expect(listed.every((i) => i.phase === ph.id)).toBe(true);
      });
      expect((await t.listPhases()).map((p) => p.id)).toContain(ph.id);
    }, 30_000);

    it("updatedAt is ISO-8601 parseable", async () => {
      const made = await t.createIssue({ title: "contract: ts" });
      expect(Number.isNaN(Date.parse(made.updatedAt))).toBe(false);
    });

    it("closePhase closes when hasPhaseClose; throws UNSUPPORTED otherwise", async () => {
      const p = await t.createPhase(`contract phase close ${Date.now()}`);
      if (t.capabilities.hasPhaseClose) {
        const closed = await eventually(async () => {
          const r = await t.closePhase(p.id);
          expect(r.state).toBe("closed");
          return r;
        });
        expect(closed.id).toBe(p.id);
      } else {
        await expect(t.closePhase(p.id)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      }
    });

    it("milestone create → list → complete when hasMilestones; throws UNSUPPORTED otherwise", async () => {
      if (!t.capabilities.hasMilestones) {
        await expect(t.createMilestone("contract m")).rejects.toMatchObject({ code: "UNSUPPORTED" });
        return;
      }
      const m = await t.createMilestone(`contract milestone ${Date.now()}`);
      expect(m.state).toBe("open");
      await eventually(async () => {
        const all = await t.listMilestones();
        expect(all.map((x) => x.id)).toContain(m.id);
      });
      const done = await t.completeMilestone(m.id);
      expect(done.state).toBe("released");
    });

    it("links: create → list → unlink when hasDependencies; absent methods otherwise", async () => {
      if (!t.capabilities.hasDependencies) {
        expect(t.linkIssues).toBeUndefined();
        return;
      }
      const a = await t.createIssue({ title: "contract: link-from" });
      const b = await t.createIssue({ title: "contract: link-to" });
      await t.linkIssues!(a.id, "blocks", b.id);
      const all = await t.listLinks!();
      expect(all).toContainEqual({ from: a.id, type: "blocks", to: b.id });
      const ofA = await t.listLinks!(a.id);
      expect(ofA).toContainEqual({ from: a.id, type: "blocks", to: b.id });
      await t.unlinkIssues!(a.id, "blocks", b.id);
      expect(await t.listLinks!(a.id)).not.toContainEqual({ from: a.id, type: "blocks", to: b.id });
    });

    it("links: linking a nonexistent issue is NOT_FOUND; cycles are rejected", async () => {
      if (!t.capabilities.hasDependencies) return;
      const a = await t.createIssue({ title: "contract: cycle-a" });
      const b = await t.createIssue({ title: "contract: cycle-b" });
      await expect(t.linkIssues!(a.id, "blocks", "no-such-id"))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await t.linkIssues!(a.id, "blocks", b.id);
      await expect(t.linkIssues!(b.id, "blocks", a.id))
        .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("estimate roundtrips when hasEstimates; silently ignored otherwise", async () => {
      const made = await t.createIssue({
        title: "contract: estimate", estimate: { points: 3, minutes: 90 },
      });
      if (t.capabilities.hasEstimates) {
        await eventually(async () => {
          expect((await t.getIssue(made.id)).estimate).toMatchObject({ points: 3, minutes: 90 });
        });
        await t.updateIssue(made.id, { estimate: { points: 5, minutes: 120 } });
        await eventually(async () => {
          expect((await t.getIssue(made.id)).estimate).toMatchObject({ points: 5, minutes: 120 });
        });
      } else {
        expect((await t.getIssue(made.id)).estimate).toBeUndefined();
      }
    }, 30_000);

    it("attachFile stores when hasIssueAttachments; method absent otherwise", async () => {
      if (!t.capabilities.hasIssueAttachments) {
        expect(t.attachFile).toBeUndefined();
        return;
      }
      const made = await t.createIssue({ title: "contract: attach" });
      const res = await t.attachFile!(made.id, "shot.png",
        Buffer.from([137, 80, 78, 71]), "image/png");
      expect(res).toBeTruthy();
    });

    it("commentIssue posts and is UNSUPPORTED when hasComments is false", async () => {
      const made = await t.createIssue({ title: "contract: comment target" });
      if (!t.capabilities.hasComments) {
        await expect(t.commentIssue(made.id, "x")).rejects.toMatchObject({ code: "UNSUPPORTED" });
        return;
      }
      const c = await t.commentIssue(made.id, "contract comment body");
      expect(c.id).toBeTruthy();
    });
  });
}
