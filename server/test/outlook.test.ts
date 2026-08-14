import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OutlookSnapshotSchema, emitOutlook, outlookLocalPath, outlookMirrorPath, readOutlook,
} from "../src/core/outlook.js";

const dirs: string[] = [];
const dir = (prefix = "cairn-outlook-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** A registered cairn project with one planned + one verified phase. */
const project = () => {
  const d = dir("cairn-outlook-proj-");
  writeFileSync(join(d, "cairn.json"),
    JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
  const p1 = join(d, ".cairn", "plans", "phases", "01-first");
  const p2 = join(d, ".cairn", "plans", "phases", "02-second");
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  writeFileSync(join(p1, "PLAN.md"), "---\nissues: [1, 2]\n---\n# plan\n");
  writeFileSync(join(p1, "VERIFICATION.md"), "# verified\n");
  writeFileSync(join(p2, "PLAN.md"), "---\nissues: [3]\n---\n# plan\n");
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("emitOutlook", () => {
  it("dual-writes schema-valid snapshots (mirror + in-repo), phases derived from plan artifacts", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, undefined, home);

    const mirror = outlookMirrorPath(proj, home);
    const local = outlookLocalPath(proj);
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(local)).toBe(true);

    const snap = OutlookSnapshotSchema.parse(JSON.parse(readFileSync(mirror, "utf8")));
    expect(JSON.parse(readFileSync(local, "utf8"))).toEqual(snap);
    expect(snap.name).toBe(proj.split("/").pop());
    expect(snap.path).toBe(proj);
    expect(snap.phases).toEqual([
      { number: 1, name: "first", planned: true, verified: true, issueCount: 2 },
      { number: 2, name: "second", planned: true, verified: false, issueCount: 1 },
    ]);
    expect(snap.sessions).toEqual({ trace: 0, probe: 0, draft: 0, thread: 0 });
  });

  it("records the git HEAD when the project is a repo, omits it when not", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, undefined, home);
    expect(readOutlook(proj, home)?.head).toBeUndefined();

    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "x"], { cwd: proj });
    emitOutlook(proj, undefined, home);
    expect(readOutlook(proj, home)?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("verb-supplied tracker block carries forward through plain emits, replaced by newer patches", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, { tracker: { open: 4, nextVerb: "work 2", asOf: "2026-08-14" } }, home);
    emitOutlook(proj, undefined, home); // plain emit must not erase it
    expect(readOutlook(proj, home)?.tracker).toEqual({ open: 4, nextVerb: "work 2", asOf: "2026-08-14" });

    emitOutlook(proj, { tracker: { open: 1, asOf: "2026-08-15" } }, home);
    expect(readOutlook(proj, home)?.tracker).toEqual({ open: 1, asOf: "2026-08-15" });
  });

  it("skips silently for a non-cairn directory", () => {
    const home = dir();
    const plain = dir("cairn-outlook-plain-");
    emitOutlook(plain, undefined, home);
    expect(existsSync(outlookMirrorPath(plain, home))).toBe(false);
    expect(existsSync(outlookLocalPath(plain))).toBe(false);
  });

  it("a corrupt mirror is replaced, not fatal", () => {
    const home = dir();
    const proj = project();
    const mirror = outlookMirrorPath(proj, home);
    mkdirSync(join(home, ".cairn", "outlook"), { recursive: true });
    writeFileSync(mirror, "{corrupt");

    emitOutlook(proj, undefined, home);
    expect(OutlookSnapshotSchema.safeParse(JSON.parse(readFileSync(mirror, "utf8"))).success).toBe(true);
  });
});

describe("readOutlook", () => {
  it("missing or corrupt snapshots read as null", () => {
    const home = dir();
    const proj = project();
    expect(readOutlook(proj, home)).toBeNull();

    const mirror = outlookMirrorPath(proj, home);
    mkdirSync(join(home, ".cairn", "outlook"), { recursive: true });
    writeFileSync(mirror, "not json");
    expect(readOutlook(proj, home)).toBeNull();
  });
});
