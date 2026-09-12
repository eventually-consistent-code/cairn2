import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { CairnError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { parseSeatDoc } from "../src/seats/schema.js";
import { loadRoster } from "../src/seats/roster.js";
import { composeBrief } from "../src/seats/brief.js";

// Builds a valid seat doc, with per-test frontmatter overrides. An override
// value of undefined DROPS the line entirely (the missing-field cases).
function seatDoc(over: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    name: "correctness",
    lens: "logic errors and drifting state",
    categories: "[logic, edge-cases]",
    dose: "standard",
    signals: "[code]",
    anchor_ten: "every path traced and sound",
    anchor_five: "happy path sound, an edge unexamined",
    anchor_zero: "a reachable logic error is present",
    honesty: "unscored beats invented",
    ...over,
  };
  const lines = Object.entries(base)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\nThe lens prose body.\n`;
}

// Seeds a temp project dir with cairn.json (plus optional seats block) and
// optional .cairn/roles/ seat files.
function makeProject(opts: {
  seats?: Record<string, unknown>;
  roles?: Record<string, string>;
} = {}): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-seats-"));
  writeFileSync(
    join(d, "cairn.json"),
    JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      ...(opts.seats ? { seats: opts.seats } : {}),
    }),
  );
  if (opts.roles) {
    mkdirSync(join(d, ".cairn", "roles"), { recursive: true });
    for (const [file, text] of Object.entries(opts.roles)) {
      writeFileSync(join(d, ".cairn", "roles", file), text);
    }
  }
  return d;
}

// Shipped-default roster order == review's axis order (the 01-..05- filename
// prefixes in templates/seats/ enforce it) — the byte-identical promise.
const DEFAULT_NAMES = [
  "correctness",
  "clarity",
  "architecture",
  "security",
  "tests",
];

describe("seat schema (parseSeatDoc)", () => {
  it("accepts a full valid definition and composes the nested scale", () => {
    const { seat, body } = parseSeatDoc(seatDoc(), "/x/correctness.md");
    expect(seat.name).toBe("correctness");
    expect(seat.categories).toEqual(["logic", "edge-cases"]);
    expect(seat.dose).toBe("standard");
    expect(seat.signals).toEqual(["code"]);
    expect(seat.scale.anchors.ten).toBe("every path traced and sound");
    expect(seat.scale.anchors.zero).toBe("a reachable logic error is present");
    expect(seat.scale.honesty).toBe("unscored beats invented");
    expect(seat.model).toBeUndefined();
    expect(body).toContain("The lens prose body.");
  });

  it("missing dose is CONFIG_INVALID naming the file and the field", () => {
    try {
      parseSeatDoc(seatDoc({ dose: undefined }), "/proj/.cairn/roles/bad.md");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      const err = e as CairnError;
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.message).toContain("/proj/.cairn/roles/bad.md");
      expect(err.message).toContain("dose: required");
      expect(err.message).toContain("minimal | standard | full");
    }
  });

  it("an invalid dose value is CONFIG_INVALID naming the field", () => {
    expect(() =>
      parseSeatDoc(seatDoc({ dose: "maximal" }), "/x/s.md"),
    ).toThrowError(/\/x\/s\.md.*dose/);
  });

  it("rejects a non-kebab name", () => {
    expect(() =>
      parseSeatDoc(seatDoc({ name: "Correct_Ness" }), "/x/s.md"),
    ).toThrowError(/name.*kebab/);
  });

  it("maps nested-scale errors back to the flat frontmatter key", () => {
    expect(() =>
      parseSeatDoc(seatDoc({ anchor_ten: undefined }), "/x/s.md"),
    ).toThrowError(/anchor_ten/);
  });

  it("accepts the advisory model and rejects unknown values", () => {
    const { seat } = parseSeatDoc(seatDoc({ model: "haiku" }), "/x/s.md");
    expect(seat.model).toBe("haiku");
    expect(() =>
      parseSeatDoc(seatDoc({ model: "gpt" }), "/x/s.md"),
    ).toThrowError(/model/);
  });
});

describe("seat roster (loadRoster)", () => {
  it("no project seats, no seats block: the five shipped defaults", () => {
    const roster = loadRoster(makeProject());
    expect(roster.seats.map((s) => s.name)).toEqual(DEFAULT_NAMES);
    expect(roster.seats.every((s) => s.valid && s.source === "default")).toBe(
      true,
    );
    expect(roster.notes).toEqual([]);
  });

  it("a project seat overrides the default by name, in place", () => {
    const d = makeProject({
      roles: { "my-correctness.md": seatDoc({ lens: "project lens" }) },
    });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual(DEFAULT_NAMES);
    const seat = roster.seats.find((s) => s.name === "correctness")!;
    expect(seat.source).toBe("project");
    expect(seat.seat?.lens).toBe("project lens");
  });

  it("a project seat with a new name appends", () => {
    const d = makeProject({
      roles: { "perf.md": seatDoc({ name: "performance" }) },
    });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual([
      ...DEFAULT_NAMES,
      "performance",
    ]);
    expect(roster.seats.at(-1)?.source).toBe("project");
  });

  it("enabled picks AND orders; unknown names become notes", () => {
    const d = makeProject({
      seats: { enabled: ["tests", "correctness", "ghost"] },
    });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual(["tests", "correctness"]);
    expect(roster.notes).toHaveLength(1);
    expect(roster.notes[0]).toContain("'ghost'");
  });

  it("disabled removes by name; the rest keep default order", () => {
    const d = makeProject({ seats: { disabled: ["security", "clarity"] } });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual([
      "correctness",
      "architecture",
      "tests",
    ]);
  });

  it("one bad project file skips that seat with a note — roster loads", () => {
    const d = makeProject({
      roles: {
        "broken.md": seatDoc({ name: "broken-seat", dose: undefined }),
        "perf.md": seatDoc({ name: "performance" }),
      },
    });
    const roster = loadRoster(d);
    const bad = roster.seats.find((s) => !s.valid)!;
    expect(bad.name).toBe("broken");
    expect(bad.source).toBe("project");
    expect(bad.note).toContain("dose");
    // the good ones all survived
    expect(roster.seats.filter((s) => s.valid).map((s) => s.name)).toEqual([
      ...DEFAULT_NAMES,
      "performance",
    ]);
  });

  it("an invalid override never shadows the default it aimed at", () => {
    const d = makeProject({
      roles: { "correctness.md": seatDoc({ dose: "wrong" }) },
    });
    const roster = loadRoster(d);
    const def = roster.seats.find((s) => s.name === "correctness" && s.valid)!;
    expect(def.source).toBe("default");
    expect(roster.seats.some((s) => !s.valid && s.note?.includes("dose"))).toBe(
      true,
    );
  });
});

describe("seats config block", () => {
  it("unknown keys in the seats block are rejected", () => {
    const d = makeProject({ seats: { enabled: ["tests"], order: ["x"] } });
    expect(() => loadConfig(d)).toThrowError(/seats/);
  });

  it("absent block parses as undefined (today's behavior)", () => {
    expect(loadConfig(makeProject()).seats).toBeUndefined();
  });
});

describe("seat_roster tool", () => {
  it("returns the wire shape over MCP", async () => {
    const projectDir = makeProject({
      roles: { "broken.md": seatDoc({ name: "broken-seat", lens: undefined }) },
    });
    const server = buildServer({
      projectDir,
      tracker: new FakeTracker(),
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({
      name: "seat_roster",
      arguments: {},
    });
    const roster = JSON.parse(
      (res.content as Array<{ text: string }>)[0].text,
    );
    expect(roster.seats).toHaveLength(6);
    const correctness = roster.seats.find(
      (s: { name: string }) => s.name === "correctness",
    );
    expect(correctness).toMatchObject({
      source: "default",
      valid: true,
      dose: "standard",
    });
    expect(correctness.lens).toContain("logic errors");
    expect(Array.isArray(correctness.categories)).toBe(true);
    expect(Array.isArray(correctness.signals)).toBe(true);
    const broken = roster.seats.find(
      (s: { name: string }) => s.name === "broken",
    );
    expect(broken.valid).toBe(false);
    expect(broken.note).toContain("lens");
    await client.close();
  });

  // Regression pin — the fold-never-stack promise, machine-checked: with no
  // project seats and no seats config block, the roster consumed over MCP IS
  // review's five axes, in review's order, with review's category coverage.
  // If this test moves, review's default behavior moved with it.
  it("no-config roster is exactly review's five axes, in order (byte-identical pin)", async () => {
    const server = buildServer({
      projectDir: makeProject(),
      tracker: new FakeTracker(),
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: "seat_roster", arguments: {} });
    const roster = JSON.parse(
      (res.content as Array<{ text: string }>)[0].text,
    ) as {
      seats: Array<{
        name: string;
        categories: string[];
        source: string;
        valid: boolean;
      }>;
      notes?: string[];
    };

    // Today's five review axes, today's order — the panel, exactly.
    expect(roster.seats.map((s) => s.name)).toEqual([
      "correctness",
      "clarity",
      "architecture",
      "security",
      "tests",
    ]);
    expect(
      roster.seats.every((s) => s.valid && s.source === "default"),
    ).toBe(true);
    expect(roster.notes).toBeUndefined();

    // Today's category coverage per axis — the rubric didn't drift either.
    const byName = Object.fromEntries(
      roster.seats.map((s) => [s.name, s.categories]),
    );
    expect(byName.correctness).toEqual([
      "logic",
      "edge-cases",
      "off-by-ones",
      "state-drift",
    ]);
    expect(byName.clarity).toEqual(["naming", "intent", "comments"]);
    expect(byName.architecture).toEqual(["layering", "coupling", "reuse"]);
    expect(byName.security).toEqual([
      "injection",
      "auth",
      "secrets",
      "trust-boundaries",
    ]);
    expect(byName.tests).toEqual(["coverage", "failability"]);
    await client.close();
  });
});

describe("wave-brief composition (composeBrief)", () => {
  // A validated seat + body straight through the real parser, so the
  // brief tests exercise the same shape the roster hands out.
  function makeSeat(over: Record<string, string | undefined> = {}) {
    return parseSeatDoc(seatDoc(over), "test-seat.md");
  }

  const BASE = {
    issue: "#160 — wave-brief templates\nBriefs compose from seat templates.",
    planExcerpt: "Wave 2 task: briefs = seat template + issue + PLAN.",
    rules: "Expected base: abc1234. Run `npm ci` in server/ first.",
  };

  // Section headings, in order — the structural fingerprint of a brief.
  function headings(text: string): string[] {
    return text.split("\n").filter((l) => l.startsWith("## "));
  }

  it("seatless: generic brief with every standing section, no leftovers", () => {
    const brief = composeBrief(BASE);
    expect(headings(brief)).toEqual([
      "## Task",
      "## Plan excerpt",
      "## Standing rules",
      "## Report",
    ]);
    expect(brief).toContain(BASE.issue);
    expect(brief).toContain(BASE.planExcerpt);
    expect(brief).toContain(BASE.rules);
    expect(brief).toContain("git merge --ff-only main");
    expect(brief).toContain("Leak-guard discipline");
    expect(brief).not.toContain("## Seat:");
    expect(brief).not.toContain("{{");
    expect(brief).not.toContain("\n\n\n");
  });

  it("with a seat: framing section leads, same structure otherwise", () => {
    const { seat, body } = makeSeat();
    const brief = composeBrief({ ...BASE, seat, seatBody: body });
    const [first, ...rest] = headings(brief);
    expect(first).toBe("## Seat: correctness");
    expect(rest).toEqual(headings(composeBrief(BASE)));
    // Standard dose: lens + categories + honesty line, quoted verbatim.
    expect(brief).toContain("Lens: logic errors and drifting state");
    expect(brief).toContain("Categories: logic, edge-cases");
    expect(brief).toContain("Honesty: unscored beats invented");
    expect(brief).not.toContain("Anchors:");
    expect(brief).not.toContain("The lens prose body.");
  });

  it("minimal dose: lens only", () => {
    const { seat, body } = makeSeat({ dose: "minimal" });
    const brief = composeBrief({ ...BASE, seat, seatBody: body });
    expect(brief).toContain("Lens: logic errors and drifting state");
    expect(brief).not.toContain("Categories:");
    expect(brief).not.toContain("Honesty:");
    expect(brief).not.toContain("Anchors:");
  });

  it("full dose: anchors and the lens prose body ride along", () => {
    const { seat, body } = makeSeat({ dose: "full" });
    const brief = composeBrief({ ...BASE, seat, seatBody: body });
    expect(brief).toContain("Categories: logic, edge-cases");
    expect(brief).toContain(
      "Anchors: 10 — every path traced and sound; " +
        "5 — happy path sound, an edge unexamined; " +
        "0 — a reachable logic error is present",
    );
    expect(brief).toContain("The lens prose body.");
  });

  it("rules omitted: slot renders empty, never a dangling marker", () => {
    const brief = composeBrief({
      issue: BASE.issue,
      planExcerpt: BASE.planExcerpt,
    });
    expect(brief).not.toContain("{{rules}}");
    expect(brief).not.toContain("\n\n\n");
  });

  it("missing template: typed NOT_FOUND naming the expected path", () => {
    const d = mkdtempSync(join(tmpdir(), "cairn-brief-"));
    try {
      composeBrief({ ...BASE, rootDir: d });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("NOT_FOUND");
      expect((e as CairnError).nextAction).toContain(
        join("templates", "wave-brief.md"),
      );
    }
  });
});
