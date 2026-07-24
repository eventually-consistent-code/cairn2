// Behavioral contract every docs connector must pass — mirror of the tracker
// contract harness (test/contract.ts). Factories return a fresh connector per
// test; live suites point one at a real backend behind env gates.

import { describe, it, expect } from "vitest";
import type { DocsConnector } from "../src/docs/types.js";

export function docsConnectorContract(
  name: string,
  factory: () => Promise<DocsConnector> | DocsConnector,
  opts: { titlePrefix?: string } = {},
): void {
  // Live backends keep pages between runs — a prefix keeps contract pages
  // recognizable and lets re-runs upsert instead of colliding.
  const t = (s: string) => `${opts.titlePrefix ?? ""}${s}`;

  describe(`docs connector contract: ${name}`, () => {
    it("declares capabilities", async () => {
      const c = await factory();
      expect(typeof c.capabilities.hasPageTree).toBe("boolean");
      expect(typeof c.capabilities.hasAttachments).toBe("boolean");
      expect(typeof c.capabilities.hasLabels).toBe("boolean");
    });

    it("ensureRoot is idempotent — same page both times", async () => {
      const c = await factory();
      const a = await c.ensureRoot(t("contract-root"));
      const b = await c.ensureRoot(t("contract-root"));
      expect(b.id).toBe(a.id);
    });

    it("create → get roundtrip preserves title and ancestry", async () => {
      const c = await factory();
      const root = await c.ensureRoot(t("contract-root"));
      const page = await c.findPage(t("contract-child"), root.id)
        ?? await c.createPage({ title: t("contract-child"), markdown: "# hi", parentId: root.id });
      const got = await c.getPage(page.id);
      expect(got.title).toBe(t("contract-child"));
      expect(got.parentId).toBe(root.id);
      expect(got.url).toBeTruthy();
    });

    it("findPage finds by title under a parent, null when absent", async () => {
      const c = await factory();
      const root = await c.ensureRoot(t("contract-root"));
      if (!(await c.findPage(t("contract-child"), root.id))) {
        await c.createPage({ title: t("contract-child"), markdown: "x", parentId: root.id });
      }
      expect((await c.findPage(t("contract-child"), root.id))?.title).toBe(t("contract-child"));
      expect(await c.findPage(t("contract-no-such-page"), root.id)).toBeNull();
    });

    it("updatePage bumps the version and keeps the id", async () => {
      const c = await factory();
      const root = await c.ensureRoot(t("contract-root"));
      const page = await c.findPage(t("contract-versioned"), root.id)
        ?? await c.createPage({ title: t("contract-versioned"), markdown: "v1", parentId: root.id });
      const before = (await c.getPage(page.id)).version ?? 0;
      const updated = await c.updatePage(page.id, {
        title: t("contract-versioned"), markdown: "v2", parentId: root.id,
      });
      expect(updated.id).toBe(page.id);
      expect(updated.version ?? 0).toBeGreaterThan(before);
    });

    it("listChildren returns pages created under the parent", async () => {
      const c = await factory();
      const root = await c.ensureRoot(t("contract-root"));
      if (!(await c.findPage(t("contract-listed"), root.id))) {
        await c.createPage({ title: t("contract-listed"), markdown: "x", parentId: root.id });
      }
      const kids = await c.listChildren(root.id);
      expect(kids.map((k) => k.title)).toContain(t("contract-listed"));
    });
  });
}
