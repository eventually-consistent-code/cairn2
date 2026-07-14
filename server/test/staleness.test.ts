import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProvenance, checkCardStaleness } from "../src/memory/staleness.js";

function initRepo(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "cairn-staleness-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "original content\n");
  execFileSync("git", ["add", "a.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
  return { dir, commit };
}

describe("checkProvenance", () => {
  it("unchanged when the file matches the recorded commit", () => {
    const { dir, commit } = initRepo();
    expect(checkProvenance(dir, "a.ts", commit)).toBe("unchanged");
  });

  it("changed when the file was modified since", () => {
    const { dir, commit } = initRepo();
    writeFileSync(join(dir, "a.ts"), "modified content\n");
    expect(checkProvenance(dir, "a.ts", commit)).toBe("changed");
  });

  it("deleted when the file no longer exists", () => {
    const { dir, commit } = initRepo();
    unlinkSync(join(dir, "a.ts"));
    expect(checkProvenance(dir, "a.ts", commit)).toBe("deleted");
  });

  it("unknown for a bad commit sha", () => {
    const { dir } = initRepo();
    expect(checkProvenance(dir, "a.ts", "0000000000000000000000000000000000000")).toBe("unknown");
  });

  it("returns unknown (never shells out unsafely) for an option-injection-shaped commit", () => {
    const { dir } = initRepo();
    expect(checkProvenance(dir, "a.ts", "--output=pwned.txt")).toBe("unknown");
    // no such file should have been created by an injected git flag
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
  });
});

describe("checkCardStaleness", () => {
  it("flags stale with a human-readable reason when a provenance file changed", () => {
    const { dir, commit } = initRepo();
    writeFileSync(join(dir, "a.ts"), "modified\n");
    const result = checkCardStaleness(dir, [{ file: "a.ts", commit }]);
    expect(result.stale).toBe(true);
    expect(result.reasons[0]).toContain("a.ts");
  });

  it("not stale when every provenance entry is unchanged", () => {
    const { dir, commit } = initRepo();
    const result = checkCardStaleness(dir, [{ file: "a.ts", commit }]);
    expect(result.stale).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("not stale (no reasons) for a card with no provenance", () => {
    const { dir } = initRepo();
    expect(checkCardStaleness(dir, [])).toEqual({ stale: false, reasons: [] });
  });
});
