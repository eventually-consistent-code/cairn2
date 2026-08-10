import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CairnError } from "../src/errors.js";
import { parseSections, flipSection } from "../src/research/sections.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";

// One research artifact exercising the whole grammar matrix in a single doc --
// the same shape scout writes into RESEARCH.md and survey writes into SURVEY.md.
const DOC = [
  "# Phase 7 research", // H1 is document title, never a section
  "",
  "## Standard stack",
  "<!-- scout: done -->",
  "prose...",
  "",
  "## Architecture",
  "<!-- scout: done 2026-08-10 -->",
  "",
  "## Pitfalls",
  "<!-- scout: done 2026-08-10 sonnet -->",
  "",
  "## Integrations",
  "<!-- scout: failed — agent timeout -->",
  "",
  "## Open questions",
  "<!-- scout: pending -->",
  "",
  "### Sub-question", // subsection, no marker => unmarked
  "",
  "## Legacy notes", // no marker at all => unmarked
  "prose only",
  "",
  "## Peer reviewed",
  "<!-- survey: done -->", // other namespace: ignored for scout
  "",
].join("\n");

describe("parseSections — grammar matrix", () => {
  const sections = parseSections(DOC, "scout");

  it("finds every ##+ section with level and 1-indexed heading line", () => {
    expect(sections.map((s) => s.heading)).toEqual([
      "Standard stack", "Architecture", "Pitfalls", "Integrations",
      "Open questions", "Sub-question", "Legacy notes", "Peer reviewed",
    ]);
    expect(sections[0].line).toBe(3);
    expect(sections[0].level).toBe(2);
    const sub = sections.find((s) => s.heading === "Sub-question")!;
    expect(sub.level).toBe(3);
    expect(sub.line).toBe(20);
  });

  it("parses bare done/pending/failed states", () => {
    expect(sections[0]).toMatchObject({ heading: "Standard stack", state: "done", markerLine: 4 });
    expect(sections[0].date).toBeUndefined();
    expect(sections[0].model).toBeUndefined();
    expect(sections[0].note).toBeUndefined();
    expect(sections.find((s) => s.heading === "Open questions")!.state).toBe("pending");
  });

  it("parses the optional ISO date", () => {
    const arch = sections.find((s) => s.heading === "Architecture")!;
    expect(arch.state).toBe("done");
    expect(arch.date).toBe("2026-08-10");
    expect(arch.model).toBeUndefined();
  });

  it("parses date + model tier token", () => {
    const pit = sections.find((s) => s.heading === "Pitfalls")!;
    expect(pit).toMatchObject({ state: "done", date: "2026-08-10", model: "sonnet" });
  });

  it("parses a free note after the dash", () => {
    const integ = sections.find((s) => s.heading === "Integrations")!;
    expect(integ.state).toBe("failed");
    expect(integ.note).toBe("agent timeout");
  });

  it("a heading with no marker is state 'unmarked' (legacy — caller decides policy)", () => {
    const legacy = sections.find((s) => s.heading === "Legacy notes")!;
    expect(legacy.state).toBe("unmarked");
    expect(legacy.markerLine).toBeUndefined();
  });

  it("markers for other namespaces are ignored, never errors", () => {
    const peer = sections.find((s) => s.heading === "Peer reviewed")!;
    expect(peer.state).toBe("unmarked");
    // ...and the same doc parsed as survey sees it as done
    const surveyed = parseSections(DOC, "survey");
    expect(surveyed.find((s) => s.heading === "Peer reviewed")!.state).toBe("done");
    expect(surveyed.find((s) => s.heading === "Standard stack")!.state).toBe("unmarked");
  });

  it("a typo'd state THROWS CONFIG_INVALID naming the line — never silently classifies", () => {
    const bad = "## Topic\n<!-- scout: don -->\n";
    let caught: unknown;
    try { parseSections(bad, "scout"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CairnError);
    const err = caught as CairnError;
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.message).toContain("line 2");
    expect(err.message).toContain("<!-- scout: don -->");
    expect(err.nextAction).toBeTruthy();
  });

  it("a malformed marker attempt (bad date shape) also throws CONFIG_INVALID", () => {
    const bad = "## Topic\n<!-- scout: done aug-10 nope not-a-date extra tokens -->\n";
    expect(() => parseSections(bad, "scout")).toThrowError(CairnError);
    try { parseSections(bad, "scout"); } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("headings inside fenced code blocks are not sections", () => {
    const doc = "## Real\n\n```md\n## Fake\n<!-- scout: don -->\n```\n";
    const out = parseSections(doc, "scout");
    expect(out.map((s) => s.heading)).toEqual(["Real"]);
  });
});

describe("flipSection", () => {
  it("replaces an existing marker in place", () => {
    const out = flipSection(DOC, "scout", "Open questions", "done",
      { date: "2026-08-11", model: "haiku" });
    const flipped = parseSections(out, "scout").find((s) => s.heading === "Open questions")!;
    expect(flipped).toMatchObject({ state: "done", date: "2026-08-11", model: "haiku" });
    expect(out).toContain("<!-- scout: done 2026-08-11 haiku -->");
    expect(out).not.toContain("<!-- scout: pending -->");
  });

  it("inserts directly under the heading when the section is unmarked", () => {
    const out = flipSection(DOC, "scout", "Legacy notes", "pending");
    const lines = out.split("\n");
    const headingIdx = lines.indexOf("## Legacy notes");
    expect(lines[headingIdx + 1]).toBe("<!-- scout: pending -->");
    // the section's prose is untouched
    expect(lines[headingIdx + 2]).toBe("prose only");
  });

  it("carries a note with the em dash", () => {
    const out = flipSection(DOC, "scout", "Architecture", "failed", { note: "rate limited" });
    expect(out).toContain("<!-- scout: failed — rate limited -->");
    const parsed = parseSections(out, "scout").find((s) => s.heading === "Architecture")!;
    expect(parsed.note).toBe("rate limited");
  });

  it("does not disturb another namespace's marker on the same section", () => {
    const out = flipSection(DOC, "survey", "Peer reviewed", "failed", { note: "stale" });
    expect(out).toContain("<!-- survey: failed — stale -->");
    // scout view of the doc is byte-identical in every scout marker
    expect(parseSections(out, "scout").find((s) => s.heading === "Standard stack")!.state)
      .toBe("done");
  });

  it("unknown heading throws typed NOT_FOUND", () => {
    let caught: unknown;
    try { flipSection(DOC, "scout", "No Such Section", "done"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CairnError);
    expect((caught as CairnError).code).toBe("NOT_FOUND");
    expect((caught as CairnError).message).toContain("No Such Section");
  });

  it("is idempotent — same state+meta yields identical output", () => {
    const once = flipSection(DOC, "scout", "Pitfalls", "done",
      { date: "2026-08-10", model: "sonnet" });
    const twice = flipSection(once, "scout", "Pitfalls", "done",
      { date: "2026-08-10", model: "sonnet" });
    expect(twice).toBe(once);
  });

  it("round-trips: parse → flip → parse keeps every other section stable", () => {
    const before = parseSections(DOC, "scout");
    const out = flipSection(DOC, "scout", "Standard stack", "failed", { note: "redo" });
    const after = parseSections(out, "scout");
    expect(after.length).toBe(before.length);
    for (const s of after) {
      if (s.heading === "Standard stack") {
        expect(s).toMatchObject({ state: "failed", note: "redo" });
      } else {
        const prev = before.find((b) => b.heading === s.heading)!;
        expect(s.state).toBe(prev.state);
        expect(s.date).toBe(prev.date);
        expect(s.model).toBe(prev.model);
        expect(s.note).toBe(prev.note);
      }
    }
  });

  it("rejects malformed meta (bad date / model / note) as CONFIG_INVALID before writing", () => {
    for (const meta of [{ date: "aug 10" }, { model: "Sonnet 4.5" }, { note: "evil --> injection" }]) {
      try {
        flipSection(DOC, "scout", "Pitfalls", "done", meta);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as CairnError).code).toBe("CONFIG_INVALID");
      }
    }
  });
});

describe("research_sections MCP tool", () => {
  let client: Client;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-research-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    writeFileSync(join(projectDir, "RESEARCH.md"), DOC);
    const server = buildServer({ projectDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  it("parse-only when no flip is given", async () => {
    const res = await call("research_sections", { path: "RESEARCH.md", namespace: "scout" });
    expect(res.isError).toBeFalsy();
    expect(res.json.sections.map((s: { heading: string }) => s.heading))
      .toContain("Standard stack");
    expect(res.json.sections.find((s: { heading: string }) => s.heading === "Legacy notes").state)
      .toBe("unmarked");
  });

  it("flip rewrites the file atomically and returns the re-parsed sections", async () => {
    const res = await call("research_sections", {
      path: "RESEARCH.md", namespace: "scout",
      flip: { heading: "Open questions", state: "done", date: "2026-08-11" },
    });
    expect(res.isError).toBeFalsy();
    const flipped = res.json.sections.find(
      (s: { heading: string }) => s.heading === "Open questions");
    expect(flipped.state).toBe("done");
    expect(flipped.date).toBe("2026-08-11");
    const onDisk = readFileSync(join(projectDir, "RESEARCH.md"), "utf8");
    expect(onDisk).toContain("<!-- scout: done 2026-08-11 -->");
  });

  it("rejects a path escaping the project dir with CONFIG_INVALID", async () => {
    const res = await call("research_sections",
      { path: "../outside.md", namespace: "scout" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("missing file is NOT_FOUND", async () => {
    const res = await call("research_sections",
      { path: "nope/RESEARCH.md", namespace: "scout" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
  });
});
