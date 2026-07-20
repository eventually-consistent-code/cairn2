import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCard, readCard, listCards, cardsDir, updateCardConfidence } from "../src/memory/cards.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-cards-"));

describe("createCard / readCard", () => {
  it("writes a card with provenance and reads it back", () => {
    const d = dir();
    const card = createCard(d, {
      type: "gotcha",
      body: "GitHub 403 can mean auth failure OR rate limiting.",
      scopePhase: 1,
      scopeIssue: "PROJ-107",
      provenance: [{ file: "server/src/tracker/github.ts", commit: "a1b2c3d" }],
    });
    expect(card.frontmatter.type).toBe("gotcha");
    expect(card.frontmatter.scopePhase).toBe("1");
    expect(card.frontmatter.provenanceFiles).toEqual(["server/src/tracker/github.ts"]);
    expect(card.frontmatter.provenanceCommits).toEqual(["a1b2c3d"]);
    expect(card.body).toContain("rate limiting");

    const reread = readCard(d, card.id);
    expect(reread).toEqual(card);
  });

  it("is idempotent for identical content (same type+body -> same id, no error)", () => {
    const d = dir();
    const a = createCard(d, { type: "decision", body: "Use FTS5." });
    const b = createCard(d, { type: "decision", body: "Use FTS5." });
    expect(a.id).toBe(b.id);
  });

  it("throws NOT_FOUND reading a card that doesn't exist", () => {
    expect(() => readCard(dir(), "decision-deadbeef")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

describe("updateCardConfidence", () => {
  it("patches frontmatter only — id and body stable", () => {
    const d = dir();
    const card = createCard(d, { type: "gotcha", body: "flaky test on arm64", confidence: "medium" });
    const updated = updateCardConfidence(d, card.id, "high");
    expect(updated.id).toBe(card.id);
    expect(updated.body).toBe(card.body);
    expect(updated.frontmatter.confidence).toBe("high");
    expect(readCard(d, card.id).frontmatter.confidence).toBe("high");
  });

  it("on unknown id throws NOT_FOUND", () => {
    const d = dir();
    expect(() => updateCardConfidence(d, "note-deadbeef", "low"))
      .toThrowError(/no card/);
  });
});

describe("listCards", () => {
  it("empty when the cards dir doesn't exist yet", () => {
    expect(listCards(dir())).toEqual([]);
  });

  it("filters by scopePhase and scopeIssue", () => {
    const d = dir();
    createCard(d, { type: "decision", body: "phase 1 only", scopePhase: 1 });
    createCard(d, { type: "decision", body: "phase 2 only", scopePhase: 2 });
    createCard(d, { type: "decision", body: "issue scoped", scopeIssue: "X-9" });
    expect(listCards(d, { scopePhase: 1 }).length).toBe(1);
    expect(listCards(d, { scopeIssue: "X-9" }).length).toBe(1);
    expect(listCards(d).length).toBe(3);
  });

  it("skips a malformed card instead of throwing", () => {
    const d = dir();
    createCard(d, { type: "decision", body: "valid one" });
    mkdirSync(cardsDir(d), { recursive: true });
    writeFileSync(join(cardsDir(d), "broken.md"), "---\ntype: not-a-real-type\n---\nbroken\n");
    const cards = listCards(d);
    expect(cards.length).toBe(1);
    expect(cards[0].body).toBe("valid one\n");
  });

  it("creates a note card with confidence and round-trips both", () => {
    const d = dir();
    const card = createCard(d, { type: "note", body: "jot: waves feel slow on CI", confidence: "low" });
    expect(card.id.startsWith("note-")).toBe(true);
    const read = readCard(d, card.id);
    expect(read.frontmatter.type).toBe("note");
    expect(read.frontmatter.confidence).toBe("low");
  });

  it("confidence is optional and absent by default", () => {
    const d = dir();
    const card = createCard(d, { type: "decision", body: "no confidence set" });
    expect(readCard(d, card.id).frontmatter.confidence).toBeUndefined();
  });
});
