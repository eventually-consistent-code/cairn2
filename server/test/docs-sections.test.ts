import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CairnError } from "../src/errors.js";
import {
  createSection,
  writeSection,
  writeSectionFile,
} from "../src/docs/sections.js";
import { flipSection, parseSections } from "../src/research/sections.js";

// One doc mixing every region kind the writer must respect: a docs-marked
// section (machine-writable), an unmarked hand-written section (untouchable),
// and a research-namespace section (a different machine's territory).
const DOC = [
  "# Architecture", // H1 is the document title, never a section
  "",
  "## Overview",
  "<!-- docs: done 2026-08-30 -->",
  "",
  "machine-written line one.",
  "machine-written line two.",
  "",
  "## Hand-written",
  "precious prose a human typed.",
  "",
  "## Research notes",
  "<!-- scout: done 2026-08-10 sonnet -->",
  "",
  "scout's findings.",
  "",
].join("\n");

describe("writeSection — in-place replace", () => {
  it("rewrites ONLY the marked region; every surrounding byte survives", () => {
    const out = writeSection(DOC, "Overview", "fresh distilled body.");
    // prefix through the marker line is byte-identical...
    const markerEnd =
      DOC.indexOf("<!-- docs: done 2026-08-30 -->") +
      "<!-- docs: done 2026-08-30 -->".length;
    expect(out.slice(0, markerEnd)).toBe(DOC.slice(0, markerEnd));
    // ...and so is everything from the next heading to EOF
    const tail = DOC.slice(DOC.indexOf("## Hand-written"));
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain("fresh distilled body.");
    expect(out).not.toContain("machine-written line one.");
  });

  it("preserves the existing marker line byte-for-byte when no state is given", () => {
    const out = writeSection(DOC, "Overview", "new body.");
    expect(out).toContain("<!-- docs: done 2026-08-30 -->");
  });

  it("rebuilds the marker when state+meta are given", () => {
    const out = writeSection(DOC, "Overview", "new body.", {
      state: "done",
      meta: { date: "2026-09-01", model: "sonnet" },
    });
    expect(out).toContain("<!-- docs: done 2026-09-01 sonnet -->");
    expect(out).not.toContain("<!-- docs: done 2026-08-30 -->");
  });

  it("is idempotent — writing identical content twice is an exact zero diff", () => {
    const body = "line one.\n\nline two after a blank.";
    const once = writeSection(DOC, "Overview", body);
    const twice = writeSection(once, "Overview", body);
    expect(twice).toBe(once);
    // and with a rebuilt marker too
    const opts = { state: "done" as const, meta: { date: "2026-09-01" } };
    const a = writeSection(DOC, "Overview", body, opts);
    const b = writeSection(a, "Overview", body, opts);
    expect(b).toBe(a);
  });

  it("missing section throws typed NOT_FOUND — never a silent append", () => {
    let caught: unknown;
    try {
      writeSection(DOC, "No Such Section", "body.");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CairnError);
    expect((caught as CairnError).code).toBe("NOT_FOUND");
    expect((caught as CairnError).message).toContain("No Such Section");
  });

  it("unmarked section throws PRECONDITION_FAILED — hand prose is untouchable", () => {
    let caught: unknown;
    try {
      writeSection(DOC, "Hand-written", "clobber attempt.");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CairnError);
    expect((caught as CairnError).code).toBe("PRECONDITION_FAILED");
    expect((caught as CairnError).nextAction).toBeTruthy();
  });

  it("a research-only marker does not count as a docs marker", () => {
    // 'Research notes' has a scout marker but no docs marker -- still protected
    expect(() => writeSection(DOC, "Research notes", "invade.")).toThrowError(
      CairnError,
    );
    try {
      writeSection(DOC, "Research notes", "invade.");
    } catch (e) {
      expect((e as CairnError).code).toBe("PRECONDITION_FAILED");
    }
  });

  it("a typo'd docs marker state throws CONFIG_INVALID, never silently writes", () => {
    const bad = "## Topic\n<!-- docs: don -->\nbody.\n";
    let caught: unknown;
    try {
      writeSection(bad, "Topic", "new body.");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CairnError);
    expect((caught as CairnError).code).toBe("CONFIG_INVALID");
    expect((caught as CairnError).message).toContain("<!-- docs: don -->");
  });

  it("a typo'd docs marker in ANOTHER section also fails the write", () => {
    const doc = [
      "## Good",
      "<!-- docs: done -->",
      "",
      "old.",
      "",
      "## Bad",
      "<!-- docs: don -->",
      "",
    ].join("\n");
    expect(() => writeSection(doc, "Good", "new.")).toThrowError(CairnError);
  });

  it("rejects a body that would restructure the doc (##+ heading or docs marker)", () => {
    for (const body of [
      "prose\n## Sneaky new section\nmore",
      "prose\n<!-- docs: done -->\nmore",
    ]) {
      try {
        writeSection(DOC, "Overview", body);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as CairnError).code).toBe("CONFIG_INVALID");
      }
    }
    // ...but fenced examples are content, not structure
    const fenced = "example:\n\n```md\n## Fake\n<!-- docs: done -->\n```";
    expect(writeSection(DOC, "Overview", fenced)).toContain("## Fake");
  });

  it("the region ends at the NEXT heading of any level — subsections stay out of reach", () => {
    const doc = [
      "## Parent",
      "<!-- docs: done -->",
      "",
      "parent body.",
      "",
      "### Child",
      "child prose.",
      "",
    ].join("\n");
    const out = writeSection(doc, "Parent", "replacement text.");
    expect(out).toContain("child prose.");
    expect(out).toContain("### Child");
    expect(out).not.toContain("parent body.");
    expect(out).toContain("replacement text.");
  });
});

describe("writeSection — research namespace untouched", () => {
  it("a docs write never disturbs scout markers or their sections", () => {
    const out = writeSection(DOC, "Overview", "rewritten.");
    const scout = parseSections(out, "scout");
    const notes = scout.find((s) => s.heading === "Research notes")!;
    expect(notes).toMatchObject({
      state: "done",
      date: "2026-08-10",
      model: "sonnet",
    });
    expect(out).toContain("scout's findings.");
    // and the research flip still composes on the written doc
    const flipped = flipSection(out, "scout", "Research notes", "pending");
    expect(flipped).toContain("<!-- scout: pending -->");
  });

  it("research suite semantics unchanged: scout parse of the ORIGINAL doc", () => {
    const sections = parseSections(DOC, "scout");
    expect(sections.find((s) => s.heading === "Overview")!.state).toBe(
      "unmarked",
    );
    expect(sections.find((s) => s.heading === "Research notes")!.state).toBe(
      "done",
    );
  });
});

describe("createSection", () => {
  it("appends a NEW section with heading + docs marker + body", () => {
    const out = createSection(DOC, "Decisions", "first decision.", {
      meta: { date: "2026-09-01" },
    });
    expect(out.startsWith(DOC.replace(/\s+$/, ""))).toBe(true);
    const lines = out.split("\n");
    const idx = lines.indexOf("## Decisions");
    expect(idx).toBeGreaterThan(0);
    expect(lines[idx + 1]).toBe("<!-- docs: done 2026-09-01 -->");
    const parsed = parseSections(out, "docs");
    expect(parsed.find((s) => s.heading === "Decisions")!.state).toBe("done");
    // ...and the new section is immediately machine-writable
    expect(writeSection(out, "Decisions", "revised decision.")).toContain(
      "revised decision.",
    );
  });

  it("an existing heading throws PRECONDITION_FAILED — no duplicate appends", () => {
    try {
      createSection(DOC, "Overview", "dupe.");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as CairnError).code).toBe("PRECONDITION_FAILED");
    }
  });

  it("honors the heading level option and rejects bad levels", () => {
    const out = createSection(DOC, "Deep dive", "body.", { level: 3 });
    expect(out).toContain("### Deep dive");
    expect(() => createSection(DOC, "Nope", "body.", { level: 1 })).toThrowError(
      CairnError,
    );
  });
});

describe("writeSectionFile — atomic file writer", () => {
  const setup = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-sections-"));
    const path = join(dir, "ARCHITECTURE.md");
    writeFileSync(path, DOC);
    return path;
  };

  it("rewrites the section on disk and reports changed: true", () => {
    const path = setup();
    const res = writeSectionFile(path, "Overview", "distilled body.");
    expect(res.changed).toBe(true);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain("distilled body.");
    expect(onDisk).toContain("precious prose a human typed.");
  });

  it("an identical second write is a zero-diff no-op (changed: false)", () => {
    const path = setup();
    writeSectionFile(path, "Overview", "distilled body.");
    const after = readFileSync(path, "utf8");
    const res = writeSectionFile(path, "Overview", "distilled body.");
    expect(res.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  it("errors leave the file untouched byte-for-byte", () => {
    const path = setup();
    for (const heading of ["Hand-written", "No Such Section"]) {
      expect(() => writeSectionFile(path, heading, "body.")).toThrowError(
        CairnError,
      );
    }
    expect(readFileSync(path, "utf8")).toBe(DOC);
  });

  it("createMissing appends an absent section but NEVER rescues an unmarked one", () => {
    const path = setup();
    const res = writeSectionFile(path, "Changelog", "v2 shipped.", {
      createMissing: true,
    });
    expect(res.changed).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("## Changelog");
    try {
      writeSectionFile(path, "Hand-written", "body.", { createMissing: true });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as CairnError).code).toBe("PRECONDITION_FAILED");
    }
  });

  // Regression: observed live (twice) -- {state: 'done', meta: '2026-09-01'}
  // produced a bare '<!-- docs: done -->' on disk. String property access
  // ('2026-09-01'.date) is undefined, so buildMarker silently dropped every
  // meta field. The date-string shorthand must land IN the rebuilt marker.
  it("regression: a bare date-string meta rebuilds the marker WITH the date", () => {
    const path = setup();
    const res = writeSectionFile(path, "Overview", "distilled body.", {
      state: "done",
      meta: "2026-09-01",
    });
    expect(res.changed).toBe(true);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain("<!-- docs: done 2026-09-01 -->");
    // the exact observed failure mode: date silently dropped to a bare marker
    expect(onDisk).not.toContain("<!-- docs: done -->");
  });

  it("meta survives a second identical write -- zero diff, date intact", () => {
    const path = setup();
    const opts = { state: "done" as const, meta: "2026-09-01" };
    writeSectionFile(path, "Overview", "distilled body.", opts);
    const after = readFileSync(path, "utf8");
    const res = writeSectionFile(path, "Overview", "distilled body.", opts);
    expect(res.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(after);
    expect(after).toContain("<!-- docs: done 2026-09-01 -->");
  });

  it("a no-opts rewrite still preserves the existing marker byte-for-byte", () => {
    const path = setup();
    const res = writeSectionFile(path, "Overview", "fresh body, no opts.");
    expect(res.changed).toBe(true);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain("<!-- docs: done 2026-08-30 -->");
    expect(onDisk).toContain("fresh body, no opts.");
  });

  it("a non-date string meta throws CONFIG_INVALID -- never a silent bare marker", () => {
    const path = setup();
    try {
      writeSectionFile(path, "Overview", "body.", {
        state: "done",
        meta: "next tuesday",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
    expect(readFileSync(path, "utf8")).toBe(DOC);
  });

  it("missing file is typed NOT_FOUND", () => {
    try {
      writeSectionFile(join(tmpdir(), "cairn-docs-nope", "x.md"), "A", "b.");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as CairnError).code).toBe("NOT_FOUND");
    }
  });
});

describe("retrofit — docs/ARCHITECTURE.md is machine-writable", () => {
  it("every ## section in the shipped doc carries a parsing docs marker", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(
      join(testDir, "..", "..", "docs", "ARCHITECTURE.md"),
      "utf8",
    );
    const sections = parseSections(doc, "docs");
    const topLevel = sections.filter((s) => s.level === 2);
    expect(topLevel.length).toBeGreaterThan(0);
    for (const s of topLevel) expect(s.state).toBe("done");
  });
});
