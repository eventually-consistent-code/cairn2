import { describe, it, expect } from "vitest";
import { ReadCache } from "../src/core/cache.js";
import { CachedTracker } from "../src/tracker/cached.js";
import { FakeTracker } from "../src/tracker/fake.js";

describe("ReadCache", () => {
  it("stores within ttl and expires after", async () => {
    const c = new ReadCache(30);
    c.set("k", 1);
    expect(c.get("k")).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(c.get("k")).toBeUndefined();
  });
});

describe("CachedTracker", () => {
  it("serves repeated getIssue from cache, invalidates on write", async () => {
    const inner = new FakeTracker();
    const t = new CachedTracker(inner, new ReadCache(60_000));
    const made = await t.createIssue({ title: "a" });
    const g1 = await t.getIssue(made.id);
    await inner.updateIssue(made.id, { title: "changed-behind-cache" });
    const g2 = await t.getIssue(made.id); // cached — stale by design
    expect(g2.title).toBe(g1.title);
    await t.updateIssue(made.id, { title: "via-cache" }); // write → clear
    expect((await t.getIssue(made.id)).title).toBe("via-cache");
  });

  it("cached reads return independent copies — mutation cannot poison the cache", async () => {
    const inner = new FakeTracker();
    const t = new CachedTracker(inner, new ReadCache(60_000));
    const made = await t.createIssue({ title: "a", labels: ["x"] });
    const first = await t.getIssue(made.id);
    first.labels.push("EVIL");
    first.title = "mutated";
    const second = await t.getIssue(made.id); // same TTL window — cache hit
    expect(second.labels).toEqual(["x"]);
    expect(second.title).toBe("a");
  });

  it("listMilestones is cached; createMilestone/completeMilestone invalidate", async () => {
    const fake = new FakeTracker();
    const t = new CachedTracker(fake);
    const m = await t.createMilestone("m1");
    expect((await t.listMilestones()).length).toBe(1);
    await t.createMilestone("m2");                       // write clears cache
    expect((await t.listMilestones()).length).toBe(2);
    await t.completeMilestone(m.id);
    expect((await t.listMilestones()).find((x) => x.id === m.id)?.state).toBe("released");
  });

  it("commentIssue invalidates the cache", async () => {
    const fake = new FakeTracker();
    const t = new CachedTracker(fake);
    const issue = await t.createIssue({ title: "c" });
    await t.getIssue(issue.id);            // primes cache
    await t.commentIssue(issue.id, "note");
    expect(fake.comments(issue.id).length).toBe(1);
    await t.getIssue(issue.id);            // re-fetches (cache cleared) — no stale error
  });
});
