import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldPhase } from "../src/planning/artifacts.js";
import { readPlanIssues } from "../src/planning/artifacts.js";
import { importPhase } from "../src/planning/import.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-import-"));

async function seedTracker() {
  const t = new FakeTracker();
  const ph = await t.createPhase("Phase 3: Billing Engine");
  const a = await t.createIssue({ title: "req one", phase: ph.id });
  const b = await t.createIssue({ title: "req two", phase: ph.id });
  await t.createIssue({ title: "unrelated" });
  return { t, ph, ids: [a.id, b.id] };
}

describe("importPhase", () => {
  it("imports a canonical-named phase keeping its number, with issues in frontmatter", async () => {
    const { t, ph, ids } = await seedTracker();
    const d = dir();
    const result = await importPhase(t, d, ph.id);
    expect(result).toMatchObject({
      dir: "03-billing-engine", number: 3, name: "Billing Engine",
      trackerPhaseId: ph.id, issues: ids,
    });
    expect(existsSync(join(d, ".cairn/plans/PROJECT.md"))).toBe(true);
    expect(readPlanIssues(d, "03-billing-engine")).toEqual(ids);
  });

  it("resolves by case-insensitive name substring", async () => {
    const { t } = await seedTracker();
    const result = await importPhase(t, dir(), "billing");
    expect(result.number).toBe(3);
  });

  it("non-canonical phase name gets the next free number", async () => {
    const t = new FakeTracker();
    const ph = await t.createPhase("Sprint 12");
    const d = dir();
    scaffoldPhase(d, 1, "Existing");
    const result = await importPhase(t, d, ph.id);
    expect(result).toMatchObject({ number: 2, dir: "02-sprint-12", name: "Sprint 12" });
  });

  it("NOT_FOUND for an unmatched ref; CONFIG_INVALID for a number collision with a different slug", async () => {
    const { t } = await seedTracker();
    await expect(importPhase(t, dir(), "zzz-nothing"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    const d2 = dir();
    scaffoldPhase(d2, 3, "Something Else"); // occupies 03- with a different slug
    await expect(importPhase(t, d2, "billing"))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("re-import is idempotent (scaffold skips, frontmatter rewritten, no error)", async () => {
    const { t, ph, ids } = await seedTracker();
    const d = dir();
    await importPhase(t, d, ph.id);
    const second = await importPhase(t, d, ph.id);
    expect(second.issues).toEqual(ids);
    expect(readPlanIssues(d, "03-billing-engine")).toEqual(ids);
  });

  it("re-importing a non-canonical phase reuses its number (no silent duplicate)", async () => {
    const t = new FakeTracker();
    const ph = await t.createPhase("Sprint 12");
    const d = dir();
    const first = await importPhase(t, d, ph.id);
    expect(first.dir).toBe("01-sprint-12");
    const second = await importPhase(t, d, ph.id);
    expect(second.dir).toBe("01-sprint-12");
    expect(second.number).toBe(1);
  });
});
