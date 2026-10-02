import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_RULE_CHARS,
  collectRules,
  enumerateControls,
  extractRules,
  headerProse,
  nearestControlType,
  pairRule,
  scanRuleCoverage,
  type Control,
  type RuleLine,
} from "../src/audit/rule-coverage.js";

/**
 * Rule-to-control coverage (#207) — the mechanical half of
 * `audit security --surface`. Extraction, enumeration and pairing are
 * asserted on fixtures; the self-scan at the bottom proves the scan sees
 * cairn's own rules and controls (never a vacuous pass).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A temp project with the given files (paths relative, parents created). */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-rulecov-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function rule(text: string): RuleLine {
  return { file: "CLAUDE.md", line: 1, text, keyword: "never", polarity: "prohibition", sourceKind: "instructions" };
}


describe("extractRules", () => {
  it("finds prohibitions and obligations, with polarity and the keyword's line", () => {
    const text = [
      "# Rules",                                   // 1
      "",                                          // 2
      "- Never commit secrets to the repo.",       // 3
      "- You must run the tests before pushing.",  // 4
      "- Plain description, nothing imperative.",  // 5
    ].join("\n");
    const rules = extractRules(text, "CLAUDE.md", "instructions");
    expect(rules.map((r) => [r.line, r.keyword, r.polarity])).toEqual([
      [3, "never", "prohibition"],
      [4, "must", "obligation"],
    ]);
    expect(rules[0].text).toBe("Never commit secrets to the repo.");
  });

  it("'must not' is a prohibition, not an obligation", () => {
    const [r] = extractRules("You must not edit dist by hand.", "AGENTS.md", "instructions");
    expect(r.polarity).toBe("prohibition");
    expect(r.keyword).toBe("must not");
  });

  it("skips fenced code — a command example is not a rule", () => {
    const text = ["```bash", "# never run this", "rm -rf /", "```", "Do not force-push main."].join("\n");
    const rules = extractRules(text, "CLAUDE.md", "instructions");
    expect(rules).toHaveLength(1);
    expect(rules[0].line).toBe(5);
  });

  it("joins a rule wrapped across lines and reports the keyword's line", () => {
    const text = ["Commits go through the agent's Bash tool, and the agent", "should never bypass the", "leak guard."].join("\n");
    const [r] = extractRules(text, "CLAUDE.md", "instructions");
    expect(r.line).toBe(2);
    expect(r.text).toBe("Commits go through the agent's Bash tool, and the agent should never bypass the leak guard.");
  });

  it("keeps file names with dots inside one sentence", () => {
    const [r] = extractRules("Never hand-edit hooks.json or the .mcp.json file. Second sentence.", "CLAUDE.md", "instructions");
    expect(r.text).toBe("Never hand-edit hooks.json or the .mcp.json file.");
  });

  it("splits sentences so one paragraph can carry several rules", () => {
    const rules = extractRules("Always quote variables. Never use eval. Be nice.", "CLAUDE.md", "instructions");
    expect(rules.map((r) => r.keyword)).toEqual(["always", "never"]);
  });

  it("list items never merge into one block", () => {
    const rules = extractRules("- never A\n- never B", "CLAUDE.md", "instructions");
    expect(rules.map((r) => r.text)).toEqual(["never A", "never B"]);
  });

  it("clips a long rule to MAX_RULE_CHARS", () => {
    const [r] = extractRules(`Never ${"x".repeat(500)}`, "CLAUDE.md", "instructions");
    expect(r.text.length).toBe(MAX_RULE_CHARS);
    expect(r.text.endsWith("…")).toBe(true);
  });
});


describe("headerProse", () => {
  it("keeps a block-comment header with line numbers intact, blanks the code", () => {
    const src = ["#!/usr/bin/env node", "", "/**", " * Purpose: never block work.", " */", "const never = 1; // never"].join("\n");
    const lines = headerProse(src).split("\n");
    expect(lines[3]).toBe("Purpose: never block work.");
    expect(lines[5]).toBe("");
  });

  it("keeps a run of # comments for shell hooks", () => {
    const src = ["#!/bin/bash", "# Do not push to main.", "git status"].join("\n");
    expect(headerProse(src).split("\n")).toEqual(["", "Do not push to main.", ""]);
  });
});


describe("enumerateControls", () => {
  it("reads hooks, permission deny/ask, guard scripts, server gates, git hooks and CI", () => {
    const dir = project({
      "hooks/hooks.json": JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/block-push.mjs"' }] }] },
      }),
      "hooks/scripts/block-push.mjs": "/**\n * Purpose: refuses git push to main.\n */\n",
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./.env)"], ask: ["Bash(git push:*)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
      }),
      "scripts/check-dist.mjs": "// Purpose: committed dist matches a fresh build.\n",
      "scripts/release.mjs": "// not a guard\n",
      "server/src/gate.ts": 'throw new CairnError("PRECONDITION_FAILED", "finding has no failure_scenario");\n',
      "server/src/plain.ts": "export const x = 1;\n",
      ".husky/pre-commit": "npx lint-staged\n",
      ".github/workflows/ci.yml": "name: ci\njobs:\n  t:\n    steps:\n      - run: npm test\n",
    });
    const controls = enumerateControls(dir);
    const ids = controls.map((c) => `${c.type} ${c.id}`);
    expect(ids).toEqual([
      "hook PreToolUse[Bash] block-push.mjs",
      "hook Stop[*] echo done",
      "permission-deny deny Read(./.env)",
      "permission-ask ask Bash(git push:*)",
      "server-gate gate.ts",
      "guard-script check-dist.mjs",
      "git-hook husky pre-commit",
      "ci-workflow ci.yml",
    ]);
    // The hook's script header feeds its vocabulary, so rules can pair with it.
    expect(controls[0].tokens).toEqual(expect.arrayContaining(["push", "main", "refuses"]));
    expect(controls.find((c) => c.type === "server-gate")!.detail).toBe("refuses with PRECONDITION_FAILED");
  });

  it("an allow rule backs nothing — only deny and ask count", () => {
    const dir = project({ ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(*)"] } }) });
    expect(enumerateControls(dir)).toEqual([]);
  });

  it("an unparseable settings file is reported skipped, not thrown", () => {
    const dir = project({ ".claude/settings.json": "{ nope" });
    const report = scanRuleCoverage(dir);
    expect(report.controls).toEqual([]);
    expect(report.skipped).toContainEqual({ path: ".claude/settings.json", reason: "unparseable" });
  });

  it("never reads a hook script that climbs out of the root", () => {
    const dir = project({
      "hooks/hooks.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "node ../../outside/evil.mjs" }] }] } }),
    });
    const [c] = enumerateControls(dir);
    expect(c.id).toBe("Stop[*] node ../../outside/evil.mjs");
  });
});


describe("trust boundary — the scan reads only what lives under the root", () => {
  it("a symlinked CLAUDE.md pointing outside the root is skipped, its lines never quoted", () => {
    const outside = project({ "secret.md": "Never share the key hunter2." });
    const dir = project({});
    symlinkSync(join(outside, "secret.md"), join(dir, "CLAUDE.md"));
    const report = scanRuleCoverage(dir);
    expect(report.rules).toEqual([]);
    expect(report.skipped).toContainEqual({ path: "CLAUDE.md", reason: "outside-root" });
  });

  it("an oversized file is skipped", () => {
    const dir = project({ "CLAUDE.md": `Never x.\n${"a".repeat(MAX_FILE_BYTES)}` });
    const report = scanRuleCoverage(dir);
    expect(report.rules).toEqual([]);
    expect(report.skipped).toContainEqual({ path: "CLAUDE.md", reason: "too-large" });
  });
});


describe("collectRules", () => {
  it("reads instruction files, verb files and hook prose — tagged by source", () => {
    const dir = project({
      "CLAUDE.md": "Never commit secrets.\n",
      "AGENTS.md": "Always run tests.\n",
      "skills/s/verbs/ship.md": "Never push a red build.\n",
      "hooks/hooks.json": JSON.stringify({ description: "Guards that must never block work.", hooks: {} }, null, 2),
      "hooks/scripts/g.mjs": "/**\n * Never block on an internal error.\n */\nconst never = 'not prose';\n",
      ".claude/hooks/x.sh": "#!/bin/bash\n# Do not run outside the project.\necho never\n",
      "README.md": "Never read by this scan.\n",
    });
    const rules = collectRules(dir);
    expect(rules.map((r) => `${r.sourceKind} ${r.file}:${r.line}`)).toEqual([
      "instructions CLAUDE.md:1",
      "instructions AGENTS.md:1",
      "verb skills/s/verbs/ship.md:1",
      "hook-prose hooks/hooks.json:2",
      "hook-prose hooks/scripts/g.mjs:2",
      "hook-prose .claude/hooks/x.sh:2",
    ]);
  });

  it("an empty project yields no rules and no controls, without throwing", () => {
    const report = scanRuleCoverage(project({}));
    expect(report.summary).toEqual({ rules: 0, controls: 0, uncovered: 0, candidate: 0, controlsByType: {} });
  });
});


describe("pairing", () => {
  const leak: Control = {
    type: "hook", id: "PreToolUse[Bash] leakguard.mjs", source: "hooks/hooks.json", detail: "",
    tokens: ["blocks", "commit", "secrets", "staged"],
  };

  it("a rule sharing enough vocabulary with a control is a candidate — never auto-covered", () => {
    const cov = pairRule(rule("Never commit secrets to the repo."), [leak]);
    expect(cov.status).toBe("candidate");
    expect(cov.candidates).toEqual([{ controlId: leak.id, type: "hook", shared: ["commit", "secrets"] }]);
  });

  it("one shared word is not enough — the rule is uncovered", () => {
    const cov = pairRule(rule("Never commit on a Friday."), [leak]);
    expect(cov.status).toBe("uncovered");
    expect(cov.candidates).toEqual([]);
  });

  it("names the nearest control type by the rule's vocabulary", () => {
    expect(nearestControlType("Never paste an API key into chat")).toBe("hook");
    expect(nearestControlType("Never force-push main")).toBe("hook");
    expect(nearestControlType("Do not hand-edit generated files")).toBe("permission-deny");
    expect(nearestControlType("Never curl-pipe into sh")).toBe("permission-deny");
    expect(nearestControlType("Always bump every version surface")).toBe("guard-script");
    expect(nearestControlType("Never close an issue without evidence")).toBe("server-gate");
    expect(nearestControlType("Be kind")).toBe("hook");
  });

  it("is deterministic — same root, same report", () => {
    const dir = project({ "CLAUDE.md": "Never commit secrets. Always run tests.\n", "scripts/check-x.mjs": "// tests\n" });
    expect(scanRuleCoverage(dir)).toEqual(scanRuleCoverage(dir));
  });
});


describe("self-scan — cairn's own surface", () => {
  const report = scanRuleCoverage(REPO_ROOT);

  it("finds rules in every source kind", () => {
    const kinds = new Set(report.rules.map((r) => r.sourceKind));
    expect([...kinds].sort()).toEqual(["hook-prose", "instructions", "verb"]);
  });

  it("enumerates the leak guard, a guard script and a server gate", () => {
    const ids = report.controls.map((c) => c.id);
    expect(ids).toContain("PreToolUse[Bash] pretooluse-leakguard.mjs");
    expect(ids).toContain("check-dist.mjs");
    expect(ids).toContain("audit/record.ts");
  });

  it("the summary adds up", () => {
    const { summary } = report;
    expect(summary.rules).toBeGreaterThan(0);
    expect(summary.uncovered + summary.candidate).toBe(summary.rules);
    expect(Object.values(summary.controlsByType).reduce((a, b) => a + (b ?? 0), 0)).toBe(summary.controls);
  });
});
