import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES, pairRule, type Control, type RuleLine } from "../src/audit/rule-coverage.js";

/**
 * Phase 25 surface gaps — the pieces of the sweep that live in prose and
 * module headers (#210, #179) plus the per-rule candidate cap (#207).
 * Each assertion fails if the thing it names is deleted or renamed.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("sunset clauses (#210)", () => {
  it("every docs/adr/0*.md carries a removeWhen: line", () => {
    const adrs = readdirSync(join(ROOT, "docs/adr")).filter((f) => /^0.*\.md$/.test(f));
    expect(adrs.length).toBeGreaterThan(0);
    const missing = adrs.filter((f) => !/^removeWhen:/m.test(read(`docs/adr/${f}`)));
    expect(missing).toEqual([]);
  });

  it("server gates and gate-shaped hook scripts state removeWhen in their module header", () => {
    const gates = [
      "server/src/context/threshold.ts",
      "server/src/seats/schema.ts",
      "server/src/seats/yield.ts",
      "server/src/seats/dedup.ts",
      "server/src/planning/close-receipt.ts",
      "server/src/planning/check.ts",
      "server/src/planning/budget-ledger.ts",
      "server/src/planning/run-manifest.ts",
      "server/src/audit/record.ts",
      "hooks/scripts/pretooluse-leakguard.mjs",
      "hooks/scripts/pretooluse-runguard.mjs",
      "hooks/scripts/posttooluse-loopcheck.mjs",
      "hooks/scripts/stop-costtracker.mjs",
      "hooks/scripts/sessionstart-continuity.mjs",
      "hooks/scripts/task-mirror-worker.mjs",
    ];
    const missing = gates.filter((g) => !existsSync(join(ROOT, g)) || !/removeWhen:/.test(read(g).split("\n").slice(0, 40).join("\n")));
    expect(missing).toEqual([]);
  });

  it("audit milestone lists components whose removal condition has arrived", () => {
    expect(read("skills/cairn-trailhead/verbs/audit.md")).toMatch(/Milestone sunset sweep[\s\S]*removeWhen/);
  });
});

describe("audit sweep mode (#179)", () => {
  const audit = read("skills/cairn-trailhead/verbs/audit.md");
  const section = audit.slice(audit.indexOf("## Sweep"));

  it("the sweep section names the shared label, the manifest scope, the delta classes and --fix", () => {
    expect(section).toContain("cairn:sweep");
    expect(section).toMatch(/audit_record\(scope: "sweep-<YYYY-MM-DD>"/);
    for (const cls of ["new", "persisting", "fixed", "regressed"]) expect(section).toContain(cls);
    expect(section).toContain("sweep --fix");
    expect(section).toContain("outlook_emit");
  });

  it("legs run in the stated order, milestone last", () => {
    const order = ["`security`", "`tests`", "`docs`", "`plans`", "`simplify`", "`memory`", "`milestone` last"];
    const at = order.map((o) => section.indexOf(o));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("the do router sends sweep / rescan / whole-project wording to audit sweep", () => {
    const route = read("skills/cairn-trailhead/verbs/do.md");
    expect(route).toMatch(/[Rr]escan this project/);
    expect(route).toContain('"sweep"');
    expect(route).toContain("/cairn:audit");
    for (const f of ["commands/audit.md", "skills/cairn-trailhead/SKILL.md", "harness/AGENTS-cairn.md"]) {
      expect(read(f), f).toContain("sweep (whole-project rescan)");
    }
  });
});

describe("rule coverage candidate cap (#207)", () => {
  it(`a rule matching more controls than MAX_CANDIDATES (${MAX_CANDIDATES}) lists only the cap`, () => {
    const rule: RuleLine = { file: "CLAUDE.md", line: 1, text: "Never commit secrets to the repo.", keyword: "never", polarity: "prohibition", sourceKind: "instructions" };
    const controls: Control[] = Array.from({ length: MAX_CANDIDATES + 2 }, (_, i) => ({
      type: "hook", id: `hook-${i}`, source: "hooks/hooks.json", detail: "", tokens: ["commit", "secrets"],
    }));
    const cov = pairRule(rule, controls);
    expect(cov.status).toBe("candidate");
    expect(cov.candidates).toHaveLength(MAX_CANDIDATES);
  });
});
