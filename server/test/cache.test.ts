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
});
