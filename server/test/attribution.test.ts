import { describe, it, expect } from "vitest";
import { attributeRent } from "../src/context/attribution.js";

const span = (sessionId: string, startedAt: string, endedAt: string, rent: number) =>
  ({ sessionId, startedAt, endedAt, rent });
const item = (id: string, closedAt: string, kind: "issue" | "commit" = "issue") =>
  ({ id, closedAt, kind });

describe("rent attribution", () => {
  it("splits a session's rent evenly across the items it closed", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 1000)],
      [item("#1", "2026-09-01T10:30:00Z"), item("#2", "2026-09-01T11:30:00Z")],
    );
    expect(out.items).toEqual([
      { id: "#1", kind: "issue", rent: 500, sessions: ["s1"] },
      { id: "#2", kind: "issue", rent: 500, sessions: ["s1"] },
    ]);
    expect(out.rentPerItem).toBe(500);
    expect(out.unclaimedRent).toBe(0);
  });

  it("shares an item across every session whose span contains it", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 1000),
       span("s2", "2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z", 400)],
      [item("#1", "2026-09-01T11:30:00Z")],
    );
    expect(out.items).toEqual([
      { id: "#1", kind: "issue", rent: 1400, sessions: ["s1", "s2"] },
    ]);
  });

  it("counts rent from a session that closed nothing as unclaimed", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 900)],
      [],
    );
    expect(out.unclaimedRent).toBe(900);
    expect(out.items).toEqual([]);
    expect(out.rentPerItem).toBe(0);
  });

  it("reports an item closed inside no span as an orphan, not as free work", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z", 100)],
      [item("#9", "2026-09-05T10:00:00Z")],
    );
    expect(out.orphanItems).toEqual(["#9"]);
    expect(out.items).toEqual([]);
    expect(out.unclaimedRent).toBe(100);
  });

  it("dedupes a commit and an issue that name the same work", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 600)],
      [item("#4", "2026-09-01T10:30:00Z", "issue"),
       item("#4", "2026-09-01T10:31:00Z", "commit")],
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual({ id: "#4", kind: "issue", rent: 600, sessions: ["s1"] });
  });

  it("prefers the issue over the commit whichever order they arrive in", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 600)],
      [item("#4", "2026-09-01T10:31:00Z", "commit"),
       item("#4", "2026-09-01T10:30:00Z", "issue")],
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual({ id: "#4", kind: "issue", rent: 600, sessions: ["s1"] });
  });

  it("tolerates an unparseable timestamp by treating the item as an orphan", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 300)],
      [item("#7", "not-a-date")],
    );
    expect(out.orphanItems).toEqual(["#7"]);
  });
});
