import { describe, it, expect } from "vitest";
import { findBoundaries, detectSymptoms } from "../src/context/boundary.js";

const read = (path: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path } }] },
});
const cleared = () => ({
  type: "user",
  message: { content: [{ type: "tool_result", content: "[Old tool result content cleared]" }] },
});
const boundaryEntry = () => ({ type: "system", subtype: "compact_boundary" });
const userSays = (text: string) => ({ type: "user", message: { content: [{ type: "text", text }] } });
const assistantSays = (text: string) => ({
  type: "assistant", message: { content: [{ type: "text", text }] },
});

describe("compaction boundaries", () => {
  it("finds a microcompact from the cleared-result marker", () => {
    expect(findBoundaries([read("/a.ts"), cleared(), read("/b.ts")]))
      .toEqual([{ index: 1, kind: "microcompact" }]);
  });

  it("finds a full compaction from the boundary entry", () => {
    expect(findBoundaries([read("/a.ts"), boundaryEntry()]))
      .toEqual([{ index: 1, kind: "compact" }]);
  });

  it("collapses a run of cleared markers into one boundary", () => {
    expect(findBoundaries([cleared(), cleared(), read("/a.ts")]))
      .toEqual([{ index: 0, kind: "microcompact" }]);
  });

  it("finds nothing in a session that never compacted", () => {
    expect(findBoundaries([read("/a.ts"), read("/b.ts")])).toEqual([]);
  });
});

describe("boundary symptoms", () => {
  it("flags a file re-read after the boundary that was read before it", () => {
    const entries = [read("/src/a.ts"), boundaryEntry(), read("/src/a.ts")];
    const out = detectSymptoms(entries, findBoundaries(entries));
    expect(out).toEqual([
      { kind: "reread", boundaryIndex: 1, evidence: "/src/a.ts" },
    ]);
  });

  it("does not flag a file first read after the boundary", () => {
    const entries = [read("/src/a.ts"), boundaryEntry(), read("/src/b.ts")];
    expect(detectSymptoms(entries, findBoundaries(entries))).toEqual([]);
  });

  it("flags a question whose subject the user already supplied pre-boundary", () => {
    const entries = [
      userSays("The deploy target is the staging cluster in us-east-1."),
      boundaryEntry(),
      assistantSays("Which deploy target should I use?"),
    ];
    const out = detectSymptoms(entries, findBoundaries(entries));
    expect(out).toEqual([
      { kind: "repeat_question", boundaryIndex: 1, evidence: "deploy target" },
    ]);
  });

  it("does not flag an assistant question about something never discussed", () => {
    const entries = [
      userSays("The deploy target is the staging cluster."),
      boundaryEntry(),
      assistantSays("Should I bump the minor version?"),
    ];
    expect(detectSymptoms(entries, findBoundaries(entries))).toEqual([]);
  });

  it("returns nothing when there are no boundaries", () => {
    const entries = [read("/src/a.ts"), read("/src/a.ts")];
    expect(detectSymptoms(entries, [])).toEqual([]);
  });
});

// Tuned against two real transcripts (20MB and 71MB) after the first pass
// flagged connective filler ("rather than", "its own") and file paths
// mentioned in prose ("/Users/jsreed/..." reading as "users jsreed") as
// repeated topics. Pinning both fixes so they don't regress.
describe("repeat_question tuning", () => {
  it("does not flag a file path mentioned in prose as a repeated topic", () => {
    const entries = [
      userSays("Check the file at /Users/jsreed/repos/app/config.ts for the setting."),
      boundaryEntry(),
      assistantSays("Should the /Users/jsreed/repos directory be renamed?"),
    ];
    expect(detectSymptoms(entries, findBoundaries(entries))).toEqual([]);
  });

  it("does not flag common connective phrases that recur by chance", () => {
    const entries = [
      userSays("I'd rather deploy now than wait for the next review."),
      boundaryEntry(),
      assistantSays("Should we go with plan A rather than plan B?"),
    ];
    expect(detectSymptoms(entries, findBoundaries(entries))).toEqual([]);
  });
});

// Each symptom must be attributed to exactly one boundary -- the nearest
// preceding one -- not to every boundary that precedes the evidence.
describe("symptom attribution across multiple boundaries", () => {
  it("attributes a reread only to the nearest preceding boundary, not every earlier one", () => {
    const entries = [
      read("/src/a.ts"),   // 0: original read, before both boundaries
      boundaryEntry(),     // 1: first boundary
      read("/src/b.ts"),   // 2: unrelated read between the boundaries
      boundaryEntry(),     // 3: second boundary
      read("/src/a.ts"),   // 4: reread, after both boundaries
    ];
    const out = detectSymptoms(entries, findBoundaries(entries));
    expect(out).toEqual([
      { kind: "reread", boundaryIndex: 3, evidence: "/src/a.ts" },
    ]);
  });

  it("attributes a repeated question only to the nearest preceding boundary", () => {
    const entries = [
      userSays("The deploy target is the staging cluster."), // 0: fact, before both boundaries
      boundaryEntry(),                                        // 1: first boundary
      assistantSays("Just narrating progress, no question here."), // 2
      boundaryEntry(),                                        // 3: second boundary
      assistantSays("Which deploy target should I use?"),     // 4: question, after both boundaries
    ];
    const out = detectSymptoms(entries, findBoundaries(entries));
    expect(out).toEqual([
      { kind: "repeat_question", boundaryIndex: 3, evidence: "deploy target" },
    ]);
  });
});

// A transcript contains all sorts of shapes; a null or bare-string element
// inside a content array must not crash the detectors.
describe("malformed content blocks", () => {
  it("does not throw on a content array containing a null and a non-object", () => {
    const entries = [
      { type: "user", message: { content: [null, "raw string", { type: "text", text: "The deploy target is prod." }] } },
      boundaryEntry(),
      { type: "assistant", message: { content: [null, { type: "text", text: "Which deploy target should I use?" }] } },
    ];
    let out: unknown;
    expect(() => { out = detectSymptoms(entries, findBoundaries(entries)); }).not.toThrow();
    expect(out).toEqual([
      { kind: "repeat_question", boundaryIndex: 1, evidence: "deploy target" },
    ]);
  });
});
