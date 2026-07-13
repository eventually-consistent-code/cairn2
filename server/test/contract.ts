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
      expect(got.state).toBe("open");
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
      if (t.capabilities.hasInProgress) expect(got.state).toBe("in_progress");
      else expect(got.state).toBe("open"); // degraded but never 'closed'
    });

    it("in_progress → open transition reads back open", async () => {
      if (!t.capabilities.hasInProgress) return;
      const made = await t.createIssue({ title: "contract: wip-return" });
      await t.updateIssue(made.id, { state: "in_progress" });
      await t.updateIssue(made.id, { state: "open" });
      await eventually(async () => {
        expect((await t.getIssue(made.id)).state).toBe("open");
      });
    }, 30_000);

    it("closed → open transition reads back open (reopen)", async () => {
      const made = await t.createIssue({ title: "contract: reopen" });
      await t.closeIssue(made.id);
      await t.updateIssue(made.id, { state: "open" });
      await eventually(async () => {
        expect((await t.getIssue(made.id)).state).toBe("open");
      });
    }, 30_000);

    it("close is effective and idempotent", async () => {
      const made = await t.createIssue({ title: "contract: close" });
      await t.closeIssue(made.id);
      await t.closeIssue(made.id); // second close must not throw
      expect((await t.getIssue(made.id)).state).toBe("closed");
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
  });
}
