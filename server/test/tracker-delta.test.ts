import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CairnError } from "../src/errors.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { trackerDelta, snapshotNote, markerPath } from "../src/planning/tracker-delta.js";

describe("trackerDelta", () => {
  let dir: string;
  let tracker: FakeTracker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-td-"));
    tracker = new FakeTracker();
  });

  it("first run initializes the cursor and reports nothing", async () => {
    await tracker.createIssue({ title: "pre-existing" });
    const r = await trackerDelta(dir, tracker);
    expect(r.initialized).toBe(true);
    expect(r.new).toEqual([]);
    expect(r.edited).toEqual([]);
    expect(r.stateChanged).toEqual([]);
    expect(existsSync(markerPath(dir))).toBe(true);
  });

  it("detects new issues and new phases after init", async () => {
    await trackerDelta(dir, tracker); // init
    const added = await tracker.createIssue({ title: "PM added this" });
    await tracker.createPhase("PM epic");
    const r = await trackerDelta(dir, tracker);
    expect(r.initialized).toBe(false);
    expect(r.new.map((i) => i.id)).toEqual([added.id]);
    expect(r.newPhases.map((p) => p.name)).toEqual(["PM epic"]);
  });

  it("detects field edits with per-field diffs; body reports field only", async () => {
    const i = await tracker.createIssue({ title: "orig", body: "b1" });
    await trackerDelta(dir, tracker, { ack: true });
    await tracker.updateIssue(i.id, { title: "renamed", body: "b2" });
    const r = await trackerDelta(dir, tracker);
    expect(r.edited).toHaveLength(1);
    const fields = r.edited[0].changes.map((c) => c.field).sort();
    expect(fields).toEqual(["body", "title"]);
    const title = r.edited[0].changes.find((c) => c.field === "title")!;
    expect(title.from).toBe("orig");
    expect(title.to).toBe("renamed");
    const body = r.edited[0].changes.find((c) => c.field === "body")!;
    expect(body.from).toBeUndefined();
  });

  it("detects state changes separately from edits", async () => {
    const i = await tracker.createIssue({ title: "x" });
    await trackerDelta(dir, tracker, { ack: true });
    await tracker.updateIssue(i.id, { state: "closed" });
    const r = await trackerDelta(dir, tracker);
    expect(r.edited).toEqual([]);
    expect(r.stateChanged).toEqual([
      expect.objectContaining({ from: "open", to: "closed" }),
    ]);
  });

  it("peek does not advance the cursor; ack does", async () => {
    await trackerDelta(dir, tracker); // init
    const added = await tracker.createIssue({ title: "sticky" });
    const peek1 = await trackerDelta(dir, tracker);
    const peek2 = await trackerDelta(dir, tracker);
    expect(peek1.new.map((i) => i.id)).toEqual([added.id]);
    expect(peek2.new.map((i) => i.id)).toEqual([added.id]); // re-surfaces
    await trackerDelta(dir, tracker, { ack: true });
    const after = await trackerDelta(dir, tracker);
    expect(after.new).toEqual([]);
  });

  it("snapshotNote absorbs cairn-side mutations so they never echo", async () => {
    const i = await tracker.createIssue({ title: "mine" });
    await trackerDelta(dir, tracker, { ack: true });
    const closed = await tracker.closeIssue(i.id);
    snapshotNote(dir, closed); // what index.ts handlers will do
    const r = await trackerDelta(dir, tracker);
    expect(r.stateChanged).toEqual([]);
  });

  it("snapshotNote is a silent no-op before init", () => {
    expect(() =>
      snapshotNote(dir, {
        id: "X-1", title: "t", body: "", state: "open", labels: [],
        updatedAt: new Date().toISOString(), url: "fake://x",
      }),
    ).not.toThrow();
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  it("corrupt marker file causes trackerDelta to reject with CONFIG_INVALID", async () => {
    // Initialize marker first
    await trackerDelta(dir, tracker);
    // Corrupt the marker file
    writeFileSync(markerPath(dir), "not json{");
    // trackerDelta should reject with CairnError
    await expect(trackerDelta(dir, tracker)).rejects.toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("corrupt marker is a silent no-op for snapshotNote", async () => {
    // Initialize marker first
    await trackerDelta(dir, tracker);
    // Corrupt the marker file
    writeFileSync(markerPath(dir), "not json{");
    // snapshotNote should not throw
    expect(() =>
      snapshotNote(dir, {
        id: "X-1", title: "t", body: "", state: "open", labels: [],
        updatedAt: new Date().toISOString(), url: "fake://x",
      }),
    ).not.toThrow();
  });

  it("tracker rejection leaves existing marker unchanged", async () => {
    const i = await tracker.createIssue({ title: "initial" });
    await trackerDelta(dir, tracker, { ack: true });
    const markerBefore = readFileSync(markerPath(dir));
    // Monkey-patch tracker.listIssues to reject
    tracker.listIssues = () => Promise.reject(new Error("tracker down"));
    // trackerDelta should reject
    await expect(trackerDelta(dir, tracker)).rejects.toThrow();
    // Marker should be unchanged
    const markerAfter = readFileSync(markerPath(dir));
    expect(markerAfter).toEqual(markerBefore);
  });

  it("detects label changes: joined label vs split labels", async () => {
    const i = await tracker.createIssue({ title: "label test", labels: ["help wanted"] });
    await trackerDelta(dir, tracker, { ack: true });
    await tracker.updateIssue(i.id, { labels: ["help", "wanted"] });
    const r = await trackerDelta(dir, tracker);
    expect(r.edited).toHaveLength(1);
    expect(r.edited[0].changes).toHaveLength(1);
    const labelChange = r.edited[0].changes[0];
    expect(labelChange.field).toBe("labels");
    expect(labelChange.from).toBe("help wanted");
    expect(labelChange.to).toBe("help, wanted");
  });
});
