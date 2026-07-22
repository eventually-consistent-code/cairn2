import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderBanner, writeBanner, bannerStats } from "../src/memory/banner.js";
import { bannerPath } from "../src/core/continuity.js";
import { createCard } from "../src/memory/cards.js";
import { ActiveContext } from "../src/active-context.js";
import { appendTrace, startTrace, traceId } from "../src/trace/store.js";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cairn-banner-"));
  dirs.push(d);
  return d;
};
const registered = (recallIndex?: { enabled?: boolean; maxCards?: number }) => {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify({
    tracker: { type: "github", config: { repo: "o/r" } },
    ...(recallIndex ? { continuity: { recallIndex } } : {}),
  }));
  return d;
};

// Every dir() this test registers also produces a real banner file under
// ~/.cairn/banner keyed by that dir's hash -- clean those up too so runs
// don't leak into the real homedir.
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(bannerPath(d), { force: true });
    rmSync(d, { recursive: true, force: true });
  }
});

describe("renderBanner", () => {
  it("returns null and writes no file when there are no cards in scope", () => {
    const d = registered();
    expect(renderBanner(d)).toBeNull();
    expect(existsSync(bannerPath(d))).toBe(false);
  });

  it("returns null (and deletes an existing banner file) when recallIndex.enabled is false", () => {
    const d = registered({ enabled: false });
    createCard(d, { type: "decision", body: "project-wide decision" });
    // Seed a stale banner file as if it were rendered before the config flipped.
    mkdirSync(dirname(bannerPath(d)), { recursive: true });
    writeFileSync(bannerPath(d), "stale content");
    expect(renderBanner(d)).toBeNull();
    expect(existsSync(bannerPath(d))).toBe(false);
  });

  it("renders id/type/title/fetch-cost rows plus header and footer per the spec table", () => {
    const d = registered();
    const card = createCard(d, { type: "gotcha", body: "GitHub 403 means throttle, not just auth" });
    const rendered = renderBanner(d)!;
    expect(rendered).toContain(`## cairn recall index — `);
    expect(rendered).toContain("| id | type | title | fetch cost |");
    expect(rendered).toContain("|----|------|-------|-----------|");
    const cost = Math.ceil(card.body.length / 4);
    expect(rendered).toContain(`| ${card.id} | gotcha | GitHub 403 means throttle, not just auth | ~${cost} tok |`);
    expect(rendered).toContain(
      `Fetch bodies on demand with mem_card_recall(id). Total if fetched: ~${cost} tok.`);
  });

  it("shows confidence in the type cell when present", () => {
    const d = registered();
    createCard(d, { type: "decision", body: "picked sqlite for the index", confidence: "high" });
    writeBanner(d);
    const text = readFileSync(bannerPath(d), "utf8");
    expect(text).toContain("| decision (high) |");
  });

  it("truncates a title to <=60 chars (first line of body)", () => {
    const d = registered();
    const longLine = "x".repeat(80);
    createCard(d, { type: "reference", body: `${longLine}\nsecond line ignored` });
    const rendered = renderBanner(d)!;
    const titleLine = rendered.split("\n").find((l) => l.startsWith("| reference-"));
    expect(titleLine).toBeDefined();
    // title cell is bounded: 59 chars + ellipsis
    expect(titleLine).toContain(`${"x".repeat(59)}…`);
    expect(titleLine).not.toContain("second line ignored");
  });

  it("byte-stability: two renders against an unchanged store are byte-identical", () => {
    const d = registered();
    createCard(d, { type: "decision", body: "decision one" });
    createCard(d, { type: "gotcha", body: "gotcha two" });
    createCard(d, { type: "constraint", body: "constraint three", scopePhase: 1 });
    new ActiveContext(d).set({ phase: 1 });

    const r1 = Buffer.from(renderBanner(d)!, "utf8");
    const r2 = Buffer.from(renderBanner(d)!, "utf8");
    expect(Buffer.compare(r1, r2)).toBe(0);
    expect(r1.equals(r2)).toBe(true);
  });

  it("orders issue-scoped before phase-scoped before project-wide cards, with id tiebreak inside each bucket", () => {
    const d = registered();
    new ActiveContext(d).set({ phase: 2, issueId: "ISSUE-9" });

    const project = createCard(d, { type: "reference", body: "project wide" });
    const phase = createCard(d, { type: "reference", body: "phase scoped", scopePhase: 2 });
    const issue = createCard(d, { type: "reference", body: "issue scoped", scopeIssue: "ISSUE-9" });
    // A second issue-scoped card to verify id-lexicographic tiebreak within the bucket.
    const issue2 = createCard(d, { type: "reference", body: "issue scoped two words", scopeIssue: "ISSUE-9" });

    const rendered = renderBanner(d)!;
    const ids = rendered.split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| id"))
      .map((l) => l.split("|")[1].trim());

    const [firstIssueId, secondIssueId] = [issue.id, issue2.id].sort();
    expect(ids).toEqual([firstIssueId, secondIssueId, phase.id, project.id]);
  });

  it("excludes cards scoped to a different phase/issue than the active context (no fallthrough)", () => {
    const d = registered();
    new ActiveContext(d).set({ phase: 1, issueId: "ISSUE-A" });
    createCard(d, { type: "reference", body: "wrong phase", scopePhase: 99 });
    createCard(d, { type: "reference", body: "wrong issue", scopeIssue: "ISSUE-OTHER" });
    const project = createCard(d, { type: "reference", body: "project wide, always in scope" });

    const rendered = renderBanner(d)!;
    expect(rendered).toContain(project.id);
    expect(rendered).not.toContain("wrong phase");
    expect(rendered).not.toContain("wrong issue");
  });

  it("caps the rendered set at recallIndex.maxCards", () => {
    const d = registered({ maxCards: 2 });
    const cards = [
      createCard(d, { type: "reference", body: "card aaa" }),
      createCard(d, { type: "reference", body: "card bbb" }),
      createCard(d, { type: "reference", body: "card ccc" }),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));

    const rendered = renderBanner(d)!;
    const ids = rendered.split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| id"))
      .map((l) => l.split("|")[1].trim());
    expect(ids.length).toBe(2);
    expect(ids).toEqual([cards[0].id, cards[1].id]);
  });

  it("banner lists open traces and stays byte-stable", () => {
    const d = registered();
    startTrace(d, "index breaks past 64KB", "GH-12");
    appendTrace(d, traceId("index breaks past 64KB"), "hypothesis", "page edge");
    writeBanner(d);
    const one = readFileSync(bannerPath(d), "utf8");
    expect(one).toContain("open traces:");
    expect(one).toContain("issue GH-12");
    expect(one).toContain("last: hypothesis");
    writeBanner(d);
    expect(readFileSync(bannerPath(d), "utf8")).toBe(one);
  });

  it("banner renders traces even with zero cards", () => {
    const d = registered();
    startTrace(d, "lonely bug", "GH-1");
    writeBanner(d);
    expect(readFileSync(bannerPath(d), "utf8")).toContain("lonely bug");
  });

  it("returns null when recallIndex.enabled is false, even with open traces", () => {
    const d = registered({ enabled: false });
    startTrace(d, "traced but banner is off", "GH-2");
    expect(renderBanner(d)).toBeNull();
    expect(existsSync(bannerPath(d))).toBe(false);
  });
});

describe("writeBanner", () => {
  it("writes the rendered banner to bannerPath", () => {
    const d = registered();
    createCard(d, { type: "decision", body: "a durable decision" });
    writeBanner(d);
    const onDisk = readFileSync(bannerPath(d), "utf8");
    expect(onDisk).toBe(renderBanner(d));
  });

  it("removes an existing banner file when there is nothing to render", () => {
    const d = registered();
    createCard(d, { type: "decision", body: "temporary" });
    writeBanner(d);
    expect(existsSync(bannerPath(d))).toBe(true);

    // Disable via a fresh config write, then re-render: nothing left to write, stale file cleared.
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { recallIndex: { enabled: false } },
    }));
    writeBanner(d);
    expect(existsSync(bannerPath(d))).toBe(false);
  });

  it("is best-effort: never throws for an unregistered project (no cairn.json)", () => {
    const d = dir(); // no cairn.json
    expect(() => writeBanner(d)).not.toThrow();
    expect(existsSync(bannerPath(d))).toBe(false);
  });
});

describe("bannerStats", () => {
  it("returns zeros when there is no banner to render", () => {
    const d = registered();
    expect(bannerStats(d)).toEqual({ bannerTokens: 0, tokensSavedVsFullInjection: 0 });
  });

  it("is best-effort: returns zeros (never throws) for an unregistered project", () => {
    const d = dir(); // no cairn.json
    expect(() => bannerStats(d)).not.toThrow();
    expect(bannerStats(d)).toEqual({ bannerTokens: 0, tokensSavedVsFullInjection: 0 });
  });

  it("computes bannerTokens and tokensSavedVsFullInjection (sum of card costs minus banner cost, floored at 0)", () => {
    const d = registered();
    const a = createCard(d, { type: "decision", body: "decision body one, moderately long text" });
    const b = createCard(d, { type: "gotcha", body: "gotcha body two, also moderately long text" });

    const rendered = renderBanner(d)!;
    const bannerTokens = Math.ceil(rendered.length / 4);
    const cardCostTotal = Math.ceil(a.body.length / 4) + Math.ceil(b.body.length / 4);

    const stats = bannerStats(d);
    expect(stats.bannerTokens).toBe(bannerTokens);
    expect(stats.tokensSavedVsFullInjection).toBe(Math.max(0, cardCostTotal - bannerTokens));
  });

  it("floors tokensSavedVsFullInjection at 0 when the banner itself costs more than the cards it indexes", () => {
    const d = registered();
    // A single tiny card: the table scaffolding (header/footer/columns) costs more
    // tokens than the one-line card body it's indexing.
    createCard(d, { type: "reference", body: "x" });
    const stats = bannerStats(d);
    expect(stats.tokensSavedVsFullInjection).toBeGreaterThanOrEqual(0);
  });
});
