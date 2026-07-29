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

describe("LocalTracker history reads", () => {
  it("listComments returns texts in file order with author from the filename", async () => {
    const { t } = fresh();
    const i = await t.createIssue({ title: "H" });
    await t.commentIssue(i.id, "first note");
    await t.commentIssue(i.id, "second note");
    const comments = await t.listComments!(i.id);
    expect(comments.map((c) => c.text)).toEqual(["first note", "second note"]);
    expect(comments[0].author).toBeTruthy();
    expect(comments[0].at).toBeTruthy();
  });

  it("listWorklogs parses minutes, author, timestamp", async () => {
    const { t } = fresh();
    const i = await t.createIssue({ title: "W" });
    await t.logWork!(i.id, 25);
    const logs = await t.listWorklogs!(i.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].minutes).toBe(25);
    expect(logs[0].author).toBeTruthy();
  });

  it("no history yet → empty arrays, never throws", async () => {
    const { t } = fresh();
    const i = await t.createIssue({ title: "E" });
    expect(await t.listComments!(i.id)).toEqual([]);
    expect(await t.listWorklogs!(i.id)).toEqual([]);
  });
});

describe("LocalTracker edges", () => {
  it("linkIssues writes one file per edge; listLinks derives both directions", async () => {
    const { dir, t } = fresh();
    const a = await t.createIssue({ title: "A" });
    const b = await t.createIssue({ title: "B" });
    await t.linkIssues!(a.id, "blocks", b.id);
    expect(existsSync(join(dir, ".tracker", "issues", a.id, "edges", `blocks--${b.id}.md`))).toBe(true);
    expect(await t.listLinks!(a.id)).toContainEqual({ from: a.id, type: "blocks", to: b.id });
    expect(await t.listLinks!(b.id)).toContainEqual({ from: a.id, type: "blocks", to: b.id });
    expect((await t.listLinks!()).length).toBe(1);
  });

  it("rejects cycles on blocks and parent-of; allows relates-to loops", async () => {
    const { t } = fresh();
    const a = await t.createIssue({ title: "A" });
    const b = await t.createIssue({ title: "B" });
    const c = await t.createIssue({ title: "C" });
    await t.linkIssues!(a.id, "blocks", b.id);
    await t.linkIssues!(b.id, "blocks", c.id);
    await expect(t.linkIssues!(c.id, "blocks", a.id))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await t.linkIssues!(a.id, "relates-to", b.id);
    await t.linkIssues!(b.id, "relates-to", a.id); // fine — undirected in spirit
  });

  it("unlink removes the file; edge to unknown issue is NOT_FOUND", async () => {
    const { dir, t } = fresh();
    const a = await t.createIssue({ title: "A" });
    const b = await t.createIssue({ title: "B" });
    await t.linkIssues!(a.id, "supersedes", b.id);
    await t.unlinkIssues!(a.id, "supersedes", b.id);
    expect(existsSync(join(dir, ".tracker", "issues", a.id, "edges", `supersedes--${b.id}.md`))).toBe(false);
    await expect(t.linkIssues!(a.id, "blocks", "lt-zzzzz"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("LocalTracker estimates", () => {
  it("declares hasEstimates and stores points/minutes in spaced frontmatter", async () => {
    const { dir, t } = fresh();
    expect(t.capabilities.hasEstimates).toBe(true);
    const i = await t.createIssue({ title: "Est", estimate: { points: 3, minutes: 90 } });
    const raw = readFileSync(join(dir, ".tracker", "issues", i.id, "issue.md"), "utf8");
    expect(raw).toMatch(/^points: 3$/m);
    expect(raw).toMatch(/^minutes: 90$/m);
    expect(i.estimate).toEqual({ points: 3, minutes: 90 });
  });

  it("reads estimates back and patches them; absent stays undefined", async () => {
    const { t } = fresh();
    const bare = await t.createIssue({ title: "No est" });
    expect((await t.getIssue(bare.id)).estimate).toBeUndefined();

    const i = await t.createIssue({ title: "Est", estimate: { points: 5 } });
    expect((await t.getIssue(i.id)).estimate).toEqual({ points: 5 });
    await t.updateIssue(i.id, { estimate: { points: 8, minutes: 120 } });
    expect((await t.getIssue(i.id)).estimate).toEqual({ points: 8, minutes: 120 });
  });
});

describe("LocalTracker attachments", () => {
  it("attachFile writes under issues/<id>/attachments and de-collides names", async () => {
    const { dir, t } = fresh();
    expect(t.capabilities.hasIssueAttachments).toBe(true);
    const i = await t.createIssue({ title: "Shots" });
    await t.attachFile!(i.id, "shot.png", Buffer.from([1]), "image/png");
    await t.attachFile!(i.id, "shot.png", Buffer.from([2]), "image/png");
    const files = readdirSync(join(dir, ".tracker", "issues", i.id, "attachments"));
    expect(files).toHaveLength(2);
    expect(files).toContain("shot.png");
    expect(files.some((f) => /^shot-.+\.png$/.test(f))).toBe(true);
  });
});

describe("LocalTracker custom states", () => {
  function vocab() {
    const dir = mkdtempSync(join(tmpdir(), "cairn-lu-"));
    return { dir, t: make(configSchema.parse({ prefix: "lt",
      states: { review: "in_progress", blocked: "open" } }), dir) };
  }

  it("vocab states store verbatim and read back with the configured category", async () => {
    const { t } = vocab();
    const i = await t.createIssue({ title: "V" });
    await t.updateIssue(i.id, { state: "review" });
    const got = await t.getIssue(i.id);
    expect(got.state).toBe("review");
    expect(got.category).toBe("in_progress");
    expect((await t.listIssues({ state: "in_progress" })).map((x) => x.id)).toContain(i.id);
    expect((await t.listIssues({ state: "review" })).map((x) => x.id)).toContain(i.id);
  });

  it("unknown custom state is CONFIG_INVALID", async () => {
    const { t } = vocab();
    const i = await t.createIssue({ title: "V" });
    await expect(t.updateIssue(i.id, { state: "wat" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
