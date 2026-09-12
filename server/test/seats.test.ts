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

const DEFAULT_NAMES = [
  "architecture",
  "clarity",
  "correctness",
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
      "architecture",
      "correctness",
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
});
