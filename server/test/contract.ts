import { describe, it, expect, beforeAll } from "vitest";
import type { Tracker } from "../src/tracker/types.js";

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

    it("update changes title and body", async () => {
      const made = await t.createIssue({ title: "contract: update", body: "old" });
      await t.updateIssue(made.id, { title: "contract: updated", body: "new" });
      const got = await t.getIssue(made.id);
      expect(got.title).toBe("contract: updated");
      expect(got.body).toContain("new");
    });

    it("in_progress maps per capabilities and reads back", async () => {
      const made = await t.createIssue({ title: "contract: wip" });
      await t.updateIssue(made.id, { state: "in_progress" });
      const got = await t.getIssue(made.id);
      if (t.capabilities.hasInProgress) expect(got.state).toBe("in_progress");
      else expect(got.state).toBe("open"); // degraded but never 'closed'
    });

    it("close is effective and idempotent", async () => {
      const made = await t.createIssue({ title: "contract: close" });
      await t.closeIssue(made.id);
      await t.closeIssue(made.id); // second close must not throw
      expect((await t.getIssue(made.id)).state).toBe("closed");
    });

    it("phase create + assignment + list filter", async () => {
      if (!t.capabilities.hasPhases) return;
      const ph = await t.createPhase(`contract-phase-${Date.now()}`);
      const made = await t.createIssue({ title: "contract: phased", phase: ph.id });
      const listed = await t.listIssues({ phase: ph.id });
      expect(listed.map((i) => i.id)).toContain(made.id);
      expect((await t.listPhases()).map((p) => p.id)).toContain(ph.id);
    });

    it("updatedAt is ISO-8601 parseable", async () => {
      const made = await t.createIssue({ title: "contract: ts" });
      expect(Number.isNaN(Date.parse(made.updatedAt))).toBe(false);
    });
  });
}
