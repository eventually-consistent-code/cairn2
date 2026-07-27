// Local-adapter behaviors the shared contract can't see: storage shape,
// spaced frontmatter, ids, priority mapping, comment/worklog files.

import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { configSchema, make, newId } from "../src/tracker/adapters/local.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cairn-lu-"));
  return { dir, t: make(configSchema.parse({ prefix: "lt" }), dir) };
}

describe("LocalTracker storage shape", () => {
  it("writes spaced frontmatter — a blank line between every field", async () => {
    const { dir, t } = fresh();
    const i = await t.createIssue({ title: "Spacing", body: "b" });
    const raw = readFileSync(join(dir, ".tracker", "issues", i.id, "issue.md"), "utf8");
    const fm = raw.split("---")[1];
    // no two field lines may be adjacent
    expect(fm).not.toMatch(/^[a-z]+: .*\n[a-z]+: /mi);
  });

  it("ids are prefix + 5-char base36 and newId retries taken ids", () => {
    const taken = new Set<string>();
    const id = newId("lt", taken);
    expect(id).toMatch(/^lt-[0-9a-z]{5}$/);
    taken.add(id);
    expect(newId("lt", taken)).not.toBe(id);
  });

  it("priority label roundtrips through the SPI", async () => {
    const { t } = fresh();
    const i = await t.createIssue({ title: "P", labels: ["core", "priority:P1"] });
    const got = await t.getIssue(i.id);
    expect(got.labels).toContain("priority:P1");
    expect(got.labels).toContain("core");
  });

  it("comments and worklog land as one file each", async () => {
    const { dir, t } = fresh();
    const i = await t.createIssue({ title: "C" });
    await t.commentIssue(i.id, "hello");
    await t.commentIssue(i.id, "again");
    await t.logWork!(i.id, 25);
    const base = join(dir, ".tracker", "issues", i.id);
    expect(readdirSync(join(base, "comments")).length).toBe(2);
    const wl = readdirSync(join(base, "worklog"));
    expect(wl.length).toBe(1);
    expect(readFileSync(join(base, "worklog", wl[0]), "utf8")).toMatch(/^25m/);
  });

  it("scaffolds config.json once with the prefix", async () => {
    const { dir, t } = fresh();
    await t.createIssue({ title: "seed" });
    const cfg = JSON.parse(readFileSync(join(dir, ".tracker", "config.json"), "utf8"));
    expect(cfg).toEqual({ prefix: "lt", version: 1 });
  });

  it("body with frontmatter-looking content survives roundtrip", async () => {
    const { t } = fresh();
    const body = "intro\n\n---\nnot: frontmatter\n---\n\noutro";
    const i = await t.createIssue({ title: "tricky", body });
    expect((await t.getIssue(i.id)).body).toContain("not: frontmatter");
  });
});
