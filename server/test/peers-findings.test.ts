import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CairnError } from "../src/errors.js";
import {
  FindingSchema, parseFindings, loadTemplate, type Finding,
} from "../src/peers/findings.js";


// A known-good finding object, reused across the matrix.
const GOOD: Finding = {
  claim: "unbounded retry loop on 429",
  evidence: "src/tracker/github.ts:112",
  evidenceType: "file-line",
  severity: "important",
  recommendation: "cap retries at 3 with backoff",
  axis: "correctness",
};

function fenced(body: string, info = "json"): string {
  return "```" + info + "\n" + body + "\n```";
}

// Scaffolds a fake repo root carrying one peer template, so loader tests
// never depend on the real skills/ tree.
function templateRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cairn-tpl-"));
  const dir = join(root, "skills", "cairn-trailhead", "templates", "peers");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return root;
}


describe("FindingSchema", () => {
  it("accepts a fully-populated finding", () => {
    expect(FindingSchema.safeParse(GOOD).success).toBe(true);
  });

  it("accepts a finding without the optional evidenceType/axis", () => {
    const { evidenceType: _et, axis: _ax, ...bare } = GOOD;
    expect(FindingSchema.safeParse(bare).success).toBe(true);
  });

  it("rejects a finding with no evidence location", () => {
    expect(FindingSchema.safeParse({ ...GOOD, evidence: "" }).success).toBe(false);
  });

  it("rejects an unknown severity", () => {
    expect(FindingSchema.safeParse({ ...GOOD, severity: "blocker" }).success).toBe(false);
  });
});


describe("parseFindings", () => {
  it("parses a single fenced finding object", () => {
    const { findings, unparsed } = parseFindings(fenced(JSON.stringify(GOOD)));
    expect(findings).toHaveLength(1);
    expect(findings[0].claim).toBe(GOOD.claim);
    expect(unparsed).toEqual([]);
  });

  it("parses a fenced array of findings", () => {
    const { findings, unparsed } = parseFindings(fenced(JSON.stringify([GOOD, GOOD])));
    expect(findings).toHaveLength(2);
    expect(unparsed).toEqual([]);
  });

  it("aggregates findings across multiple fences", () => {
    const raw = fenced(JSON.stringify(GOOD)) + "\n\nand another thing...\n\n" +
      fenced(JSON.stringify([{ ...GOOD, severity: "minor" }]));
    const { findings, unparsed } = parseFindings(raw);
    expect(findings).toHaveLength(2);
    expect(findings[1].severity).toBe("minor");
    expect(unparsed).toEqual([]);
  });

  it("parses a bare fence whose content is valid finding JSON", () => {
    const { findings, unparsed } = parseFindings(fenced(JSON.stringify(GOOD), ""));
    expect(findings).toHaveLength(1);
    expect(unparsed).toEqual([]);
  });

  it("routes malformed JSON in a json fence to unparsed, verbatim", () => {
    const bad = '{"claim": "half a finding", "severity": ';
    const { findings, unparsed } = parseFindings(fenced(bad));
    expect(findings).toEqual([]);
    expect(unparsed).toEqual([bad]);
  });

  it("routes valid JSON of the wrong shape to unparsed", () => {
    const wrong = '{"summary": "looks fine to me", "score": 9}';
    const { findings, unparsed } = parseFindings(fenced(wrong));
    expect(findings).toEqual([]);
    expect(unparsed).toEqual([wrong]);
  });

  it("keeps the good findings when one array element is bad", () => {
    const bad = { claim: "no evidence given", severity: "critical" };
    const raw = fenced(JSON.stringify([GOOD, bad, { ...GOOD, claim: "second good" }]));
    const { findings, unparsed } = parseFindings(raw);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.claim)).toEqual([GOOD.claim, "second good"]);
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]).toContain("no evidence given");
  });

  it("returns prose-only output whole as unparsed", () => {
    const prose = "Overall the diff looks reasonable but I worry about the retry loop.";
    const { findings, unparsed } = parseFindings(prose);
    expect(findings).toEqual([]);
    expect(unparsed).toEqual([prose]);
  });

  it("ignores leading/trailing prose when fences are present", () => {
    const raw = "Here are my findings:\n\n" + fenced(JSON.stringify(GOOD)) +
      "\n\nHope that helps!";
    const { findings, unparsed } = parseFindings(raw);
    expect(findings).toHaveLength(1);
    expect(unparsed).toEqual([]);
  });

  it("strips the stderr section before parsing", () => {
    const raw = fenced(JSON.stringify(GOOD)) +
      "\n--- stderr ---\nWARN something\n" + fenced('{"claim": "noise"}');
    const { findings, unparsed } = parseFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].claim).toBe(GOOD.claim);
    expect(unparsed).toEqual([]);
  });

  it("routes a fence truncated mid-JSON to unparsed", () => {
    // Fence opened, output cut off before the closing fence — the classic
    // maxBuffer / timeout truncation shape.
    const cut = '```json\n[{"claim": "got cut o';
    const { findings, unparsed } = parseFindings("preamble\n" + cut);
    expect(findings).toEqual([]);
    expect(unparsed).toEqual(['[{"claim": "got cut o']);
  });

  it("returns empty results for empty output", () => {
    expect(parseFindings("")).toEqual({ findings: [], unparsed: [] });
    expect(parseFindings("   \n  ")).toEqual({ findings: [], unparsed: [] });
  });

  it("treats output with only a non-JSON code fence as prose", () => {
    const raw = "Try this instead:\n" + fenced("npm run build", "sh");
    const { findings, unparsed } = parseFindings(raw);
    expect(findings).toEqual([]);
    expect(unparsed).toEqual([raw.trim()]);
  });
});


describe("loadTemplate", () => {
  it("replaces all three slots, every occurrence", () => {
    const root = templateRoot({
      "test-slots.md": "F:{{focus}} D:{{dimension}}\n{{content}}\nagain F:{{focus}}",
    });
    const out = loadTemplate("test-slots.md", {
      focus: "error paths", dimension: "security", content: "THE DIFF",
    }, root);
    expect(out).toBe("F:error paths D:security\nTHE DIFF\nagain F:error paths");
  });

  it("throws CairnError NOT_FOUND for a missing template", () => {
    const root = templateRoot({});
    try {
      loadTemplate("nope.md", {}, root);
      expect.unreachable("loadTemplate should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("NOT_FOUND");
    }
  });

  it("leaves a slot with no provided value verbatim", () => {
    const root = templateRoot({ "test-verbatim.md": "keep {{dimension}} as-is" });
    const out = loadTemplate("test-verbatim.md", { focus: "x" }, root);
    expect(out).toBe("keep {{dimension}} as-is");
  });

  it("loads the real findings-request template from the repo by default", () => {
    const out = loadTemplate("findings-request.md", {
      focus: "the retry loop", dimension: "full pass", content: "diff goes here",
    });
    expect(out).toContain("the retry loop");
    expect(out).toContain("diff goes here");
    expect(out).not.toContain("{{focus}}");
    expect(out).not.toContain("{{content}}");
    expect(out).not.toContain("{{dimension}}");
    // The contract the parser depends on rides in the template itself.
    expect(out).toContain("```json");
    expect(out).toContain('"severity"');
    expect(out).toContain('"evidence"');
  });

  it("loads the real round2-steelman template from the repo by default", () => {
    const out = loadTemplate("round2-steelman.md", {
      focus: "full pass", dimension: "full pass", content: "claim vs counter-read",
    });
    expect(out).toContain("claim vs counter-read");
    expect(out).not.toContain("{{content}}");
  });
});
