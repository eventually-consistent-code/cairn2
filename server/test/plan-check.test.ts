import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { judgeApproaches, planCheck } from "../src/planning/check.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-plancheck-"));
const plan = (dir: string, phaseDir: string, body: string) => {
  const base = join(dir, ".cairn", "plans", "phases", phaseDir);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "PLAN.md"), body);
};
const context = (dir: string, phaseDir: string, body: string) => {
  const base = join(dir, ".cairn", "plans", "phases", phaseDir);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "CONTEXT.md"), body);
};
const PLANNED = (depth?: string) =>
  `---\nissues: [7]\n${depth ? `depth: ${depth}\n` : ""}---\n# Phase 1\n\n## Tasks\n- #7 do it\n`;
const GOOD_BLOCK = [
  "# Phase 1 — Context", "", "## Locked decisions", "", "- x", "",
  "## Approaches considered", "",
  "### A — the obvious one", "Trade-offs: cheap, brittle", "",
  "### B — the careful one", "Trade-offs: slower, survives change", "",
  "chosen: B — because the next change is already on the roadmap", "",
  "## Constraints", "", "- none", "",
].join("\n");

describe("planCheck — contract drift", () => {
  it("flags a consumer whose contract text differs from the producer, naming both ends", () => {
    const dir = fresh();
    plan(dir, "01-api", [
      "# Phase 1", "",
      "- Produces: `exportRows(filter: Filter): Stream` — streaming, no buffering", "",
    ].join("\n"));
    plan(dir, "02-ui", [
      "# Phase 2", "",
      "- Consumes: `exportRows(filter: Filter, limit: number): Stream`", "",
    ].join("\n"));
    const { findings, scanned } = planCheck(dir);
    expect(scanned).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("contract-drift");
    expect(findings[0].plan).toContain("02-ui");
    expect(findings[0].counterpart?.plan).toContain("01-api");
  });

  it("is silent when both plans reference a shared fixture", () => {
    const dir = fresh();
    plan(dir, "01-api", [
      "- Produces: `exportRows(filter: Filter): Stream`",
      "  contract pinned in test/fixtures/export-contract.json", "",
    ].join("\n"));
    plan(dir, "02-ui", [
      "- Consumes: `exportRows(filter: Filter, limit: number): Stream`",
      "  contract pinned in test/fixtures/export-contract.json", "",
    ].join("\n"));
    expect(planCheck(dir).findings).toHaveLength(0);
  });

  it("is silent when contract texts match after whitespace normalization", () => {
    const dir = fresh();
    plan(dir, "01-a", "- Produces: `run(x: number): void`\n");
    plan(dir, "02-b", "- Consumes:   `run(x: number): void`\n");
    expect(planCheck(dir).findings).toHaveLength(0);
  });
});

describe("planCheck — unanchored thresholds", () => {
  it("flags a bare threshold and stays silent on an anchored one", () => {
    const dir = fresh();
    plan(dir, "01-perf", [
      "Response must be < 100ms for the dashboard.",
      "Throughput at least 500 rps per benchmark results in perf/baseline.json.", "",
    ].join("\n"));
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("unanchored-threshold");
    expect(findings[0].line).toBe(1);
    expect(findings[0].detail).toContain("< 100ms");
  });

  it("phase filter narrows the scan and output is byte-stable", () => {
    const dir = fresh();
    plan(dir, "01-perf", "Latency < 100ms.\n");
    plan(dir, "02-other", "Latency < 200ms.\n");
    const one = planCheck(dir, 1);
    expect(one.scanned).toBe(1);
    expect(one.findings).toHaveLength(1);
    expect(JSON.stringify(planCheck(dir))).toBe(JSON.stringify(planCheck(dir)));
  });

  it("empty project: zero findings, zero scanned", () => {
    expect(planCheck(fresh())).toEqual({ findings: [], scanned: 0 });
  });
});

describe("planCheck — approaches considered (phase 23)", () => {
  it("flags a planned standard-depth phase whose CONTEXT.md has no block, anchored on CONTEXT.md", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED());
    context(dir, "01-core", "# Phase 1 — Context\n\n## Locked decisions\n\n- x\n");
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "missing-approaches", line: 1 });
    expect(findings[0].plan).toContain("01-core/CONTEXT.md");
    expect(findings[0].detail).toMatch(/no '## Approaches considered' block/);
  });

  it("names what's incomplete: one candidate, or no chosen line", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED("deep"));
    context(dir, "01-core", "# C\n\n## Approaches considered\n\n### A — only one\nTrade-offs: none\n\nchosen: A — because\n");
    expect(planCheck(dir).findings[0].detail).toMatch(/1 candidate heading \(needs 2\+/);
    context(dir, "01-core", "# C\n\n## Approaches considered\n\n### A — one\n\n### B — two\n\n## Constraints\n\nchosen: B — too late, wrong section\n");
    expect(planCheck(dir).findings[0].detail).toMatch(/no 'chosen:' line/);
  });

  it("passes with two candidates and a chosen line; the fresh scaffold's comment-only skeleton does NOT pass", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED());
    context(dir, "01-core", GOOD_BLOCK);
    expect(planCheck(dir).findings).toEqual([]);
    expect(judgeApproaches([
      "## Approaches considered", "", "<!-- ### A — <name>", "     ### B — <name>", "     chosen: <letter> -->",
    ])).not.toBeNull();
  });

  it("never gates a quick-depth phase, an unplanned (issue-less) phase, or a missing CONTEXT.md on an unplanned phase", () => {
    const dir = fresh();
    plan(dir, "01-quick", PLANNED("quick"));
    context(dir, "01-quick", "# C\n");
    plan(dir, "02-scaffold", "---\nissues: []\n---\n# Phase 2\n");
    context(dir, "02-scaffold", "# C\n");
    plan(dir, "03-noctx", "---\nissues: []\n---\n# Phase 3\n");
    expect(planCheck(dir).findings).toEqual([]);
    // ...but a PLANNED phase with no CONTEXT.md at all is flagged.
    plan(dir, "04-planned-noctx", PLANNED());
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].plan).toContain("04-planned-noctx/CONTEXT.md");
  });

  it("output stays byte-stable and sorts with the other finding types", () => {
    const dir = fresh();
    plan(dir, "01-core", `---\nissues: [7]\n---\n# Phase 1\n\nLatency < 100ms.\n`);
    context(dir, "01-core", "# C\n");
    const a = planCheck(dir);
    expect(a.findings.map((f) => f.type)).toEqual(["missing-approaches", "unanchored-threshold"]);
    expect(JSON.stringify(planCheck(dir))).toBe(JSON.stringify(a));
  });

  it("phase filter matches a decimal phase dir (01.5-slug), not just integer dirs (CRN-40)", () => {
    const dir = fresh();
    plan(dir, "01.5-perf", "Latency < 100ms.\n");
    plan(dir, "02-other", "Latency < 200ms.\n");
    const one = planCheck(dir, 1.5);
    expect(one.scanned).toBe(1);
    expect(one.findings).toHaveLength(1);
    expect(one.findings[0].plan).toContain("01.5-perf");
  });

  it("phase filter rejects an over-precise decimal (1.55) as CONFIG_INVALID", () => {
    const dir = fresh();
    plan(dir, "01.5-perf", "Latency < 100ms.\n");
    expect(() => planCheck(dir, 1.55)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("adjacent independent thresholds do not anchor each other", () => {
    const dir = fresh();
    plan(dir, "01-perf", [
      "Response must be < 100ms per perf/baseline.json.",
      "Throughput at least 500 rps for the same run.", "",
    ].join("\n"));
    const { findings } = planCheck(dir);
    // Line 1 is anchored by its own path token. Line 2 is a separate,
    // self-contained threshold statement — it does not inherit line 1's
    // anchor just for being adjacent, so it (and only it) gets flagged.
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("unanchored-threshold");
    expect(findings[0].line).toBe(2);
  });
});

describe("planCheck — determinism", () => {
  it("multi-producer drift onto one consumer is deterministically ordered", () => {
    const dir = fresh();
    plan(dir, "01-alpha", [
      "# Phase 1", "",
      "- Produces: `foo(x: number): string`", "",
    ].join("\n"));
    plan(dir, "02-beta", [
      "# Phase 2", "",
      "- Produces: `bar(y: number): boolean`", "",
    ].join("\n"));
    plan(dir, "03-gamma", [
      "# Phase 3", "",
      "- Consumes: `foo(x: number, extra: string): string` and `bar(y: number): string`", "",
    ].join("\n"));

    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.type === "contract-drift")).toBe(true);
    expect(findings.every((f) => f.plan.includes("03-gamma"))).toBe(true);

    // Same consumer plan/line for both findings — the tie-break must fall
    // through to counterpart.plan, and it must land in sorted order.
    expect(findings[0].counterpart?.plan).toContain("01-alpha");
    expect(findings[1].counterpart?.plan).toContain("02-beta");

    const first = JSON.stringify(planCheck(dir));
    const second = JSON.stringify(planCheck(dir));
    expect(first).toBe(second);
  });
});
