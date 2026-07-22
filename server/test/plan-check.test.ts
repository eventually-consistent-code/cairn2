import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planCheck } from "../src/planning/check.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-plancheck-"));
const plan = (dir: string, phaseDir: string, body: string) => {
  const base = join(dir, ".cairn", "plans", "phases", phaseDir);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "PLAN.md"), body);
};

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
