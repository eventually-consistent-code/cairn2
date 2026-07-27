// Merge-safety regression — probe CRN-51's E1b scenarios as durable tests.
// Every edit goes THROUGH a LocalTracker instance on a branch checkout, then
// the branches merge with stock git. Clean merges are the storage contract.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { configSchema, make } from "../src/tracker/adapters/local.js";
import type { Tracker } from "../src/tracker/types.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-lm-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  return dir;
}

function tracker(dir: string): Tracker {
  return make(configSchema.parse({ prefix: "lt" }), dir);
}

function commitAll(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
}

/** Runs edits on two branches from a common seed, merges, returns clean? */
async function branchAndMerge(
  seed: (t: Tracker) => Promise<Record<string, string>>,
  left: (t: Tracker, ctx: Record<string, string>) => Promise<void>,
  right: (t: Tracker, ctx: Record<string, string>) => Promise<void>,
): Promise<{ clean: boolean; dir: string }> {
  const dir = repo();
  const ctx = await seed(tracker(dir));
  commitAll(dir, "seed");
  git(dir, "checkout", "-qb", "left");
  await left(tracker(dir), ctx);
  commitAll(dir, "left");
  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-qb", "right");
  await right(tracker(dir), ctx);
  commitAll(dir, "right");
  try {
    git(dir, "merge", "-q", "left");
    return { clean: true, dir };
  } catch {
    git(dir, "merge", "--abort");
    return { clean: false, dir };
  }
}

describe("local store merge safety (probe E1b, productionized)", () => {
  it("two branches creating issues merge clean", async () => {
    const { clean, dir } = await branchAndMerge(
      async (t) => ({ seed: (await t.createIssue({ title: "seed" })).id }),
      async (t) => { await t.createIssue({ title: "left issue" }); },
      async (t) => { await t.createIssue({ title: "right issue" }); },
    );
    expect(clean).toBe(true);
    expect((await tracker(dir).listIssues()).length).toBe(3);
  });

  it("both sides commenting the same issue merges clean", async () => {
    const { clean, dir } = await branchAndMerge(
      async (t) => ({ id: (await t.createIssue({ title: "seed" })).id }),
      async (t, c) => { await t.commentIssue(c.id, "left comment"); },
      async (t, c) => { await t.commentIssue(c.id, "right comment"); },
    );
    expect(clean).toBe(true);
    void dir;
  });

  it("both sides adding different edges to the same issue merges clean", async () => {
    const { clean, dir } = await branchAndMerge(
      async (t) => {
        const a = await t.createIssue({ title: "A" });
        const b = await t.createIssue({ title: "B" });
        const c = await t.createIssue({ title: "C" });
        return { a: a.id, b: b.id, c: c.id };
      },
      async (t, x) => { await t.linkIssues!(x.a, "blocks", x.b); },
      async (t, x) => { await t.linkIssues!(x.a, "relates-to", x.c); },
    );
    expect(clean).toBe(true);
    expect((await tracker(dir).listLinks!(undefined)).length).toBe(2);
  });

  it("different fields of the same issue edited on two branches merges clean", async () => {
    const { clean, dir } = await branchAndMerge(
      async (t) => ({ id: (await t.createIssue({ title: "seed", body: "b" })).id }),
      async (t, c) => { await t.updateIssue(c.id, { state: "in_progress" }); },
      async (t, c) => { await t.updateIssue(c.id, { title: "renamed" }); },
    );
    expect(clean).toBe(true);
    const merged = await tracker(dir).listIssues();
    expect(merged[0].state).toBe("in_progress");
    expect(merged[0].title).toBe("renamed");
  });

  it("same field changed both sides conflicts loudly (desired failure mode)", async () => {
    const { clean } = await branchAndMerge(
      async (t) => ({ id: (await t.createIssue({ title: "seed" })).id }),
      async (t, c) => { await t.updateIssue(c.id, { state: "in_progress" }); },
      async (t, c) => { await t.updateIssue(c.id, { state: "closed" }); },
    );
    expect(clean).toBe(false);
  });
});
