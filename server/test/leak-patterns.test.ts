import { describe, it, expect } from "vitest";
// @ts-expect-error untyped hook module
import { buildPatterns, scanLines, isAllowedPath } from "../../hooks/scripts/leak-patterns.mjs";

const jiraCfg = { tracker: { type: "jira", config: { projectKey: "DRILL" } }, leakGuard: { enabled: true, allow: [], extraPatterns: [] } };
const ghCfg = { tracker: { type: "github", config: { repo: "o/r" } }, leakGuard: { enabled: true, allow: [], extraPatterns: [] } };

describe("leak patterns", () => {
  it("hits every default class", () => {
    const pats = buildPatterns(jiraCfg);
    const hits = scanLines([
      'const p = ".cairn/plans/roadmap.md";',
      "// see phases/03-switchback for context",
      "// archived in milestones/v1",
      'label: "cairn:seed",',
      "// tracked as DRILL-42",
      "const clean = true;",
    ], pats);
    expect(hits.map((h) => h.name).sort())
      .toEqual(["cairn-label", "cairn-path", "phase-ref", "phase-ref", "tracker-id"].sort());
    expect(hits.some((h) => h.line === 6)).toBe(false);
  });

  it("github config gets NO tracker-id pattern — #N never matches", () => {
    const pats = buildPatterns(ghCfg);
    expect(scanLines(["// fixes #123 properly"], pats)).toEqual([]);
  });

  it("extraPatterns extend; invalid regexes are skipped silently", () => {
    const pats = buildPatterns({ ...ghCfg, leakGuard: { enabled: true, allow: [], extraPatterns: ["SECRET_PLAN", "(["] } });
    expect(scanLines(["// SECRET_PLAN here"], pats).some((h) => h.name === "extra")).toBe(true);
  });

  it("allowlist: defaults + trailing-/** config globs", () => {
    expect(isAllowedPath(".cairn/plans/PLAN.md", [])).toBe(true);
    expect(isAllowedPath("docs/adr/0001-x.md", [])).toBe(true);
    expect(isAllowedPath("notes.md", [])).toBe(true);
    expect(isAllowedPath("src/thing.ts", [])).toBe(false);
    expect(isAllowedPath("generated/deep/file.ts", ["generated/**"])).toBe(true);
    expect(isAllowedPath("src/one.ts", ["src/one.ts"])).toBe(true);
  });
});
