import { describe, it, expect } from "vitest";
// @ts-expect-error untyped hook module
import { buildPatterns, scanLines, isAllowedPath, patternsForFile } from "../../hooks/scripts/leak-patterns.mjs";

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

  // #140 path-scoped exemption -- fixture strings are concatenated so this
  // file's own diff never trips the live guard when committed.
  describe("patternsForFile: server-source cairn-path exemption (#140)", () => {
    const cairnRef = 'const dir = ".cairn' + '/plans/x";';
    const trackerRef = "// tracked as DRILL" + "-42";
    const labelRef = 'label: "cairn' + ':seed",';

    it("server/src and server/dist skip cairn-path ONLY — other patterns intact", () => {
      const pats = buildPatterns(jiraCfg);
      for (const p of ["server/src/planning/ledger.ts", "server/dist/planning/ledger.js"]) {
        const active = patternsForFile(p, pats);
        expect(scanLines([cairnRef], active)).toEqual([]);
        expect(scanLines([trackerRef], active).map((h: { name: string }) => h.name)).toEqual(["tracker-id"]);
        expect(scanLines([labelRef], active).map((h: { name: string }) => h.name)).toEqual(["cairn-label"]);
      }
    });

    it("every other path keeps cairn-path at full strength", () => {
      const pats = buildPatterns(jiraCfg);
      for (const p of ["src/thing.ts", "hooks/scripts/x.mjs", "server/test/fixture.ts", "serverx/src/a.ts"]) {
        expect(scanLines([cairnRef], patternsForFile(p, pats)).map((h: { name: string }) => h.name))
          .toEqual(["cairn-path"]);
      }
    });

    it("absolute paths containing /server/src/ are exempt too (CLI mode)", () => {
      const pats = buildPatterns(ghCfg);
      expect(scanLines([cairnRef], patternsForFile("/Users/x/repo/server/src/a.ts", pats))).toEqual([]);
    });
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
