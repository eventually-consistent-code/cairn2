import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIND_SPECS, appendSession, closeSession, lastSessionEntry, listSessions,
  sessionId, sessionResolution, startSession,
} from "../src/sessions/store.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-sessions-"));

describe("sessions store — probe kind", () => {
  it("starts, appends the probe entry kinds, lists with counts and phase", () => {
    const dir = fresh();
    const { id, path } = startSession(dir, "probe", "can the SDK stream?", "GH-40", "3");
    expect(id).toBe(sessionId("probe", "can the SDK stream?"));
    expect(id.startsWith("probe-")).toBe(true);
    expect(path).toBe(join(dir, ".cairn", "probe", `${id}.md`));
    appendSession(dir, "probe", id, "experiment", "ran streaming POC against fake feed");
    appendSession(dir, "probe", id, "result", "chunks arrive but out of order past 1MB");
    appendSession(dir, "probe", id, "requirement", "must reorder client-side");
    appendSession(dir, "probe", id, "verdict", "PARTIAL — streams, but needs reorder buffer");
    const [info] = listSessions(dir, "probe", "open");
    expect(info.kind).toBe("probe");
    expect(info.phase).toBe("3");
    expect(info.entryCounts).toEqual({ experiment: 1, result: 1, requirement: 1, verdict: 1 });
    expect(lastSessionEntry(dir, "probe", id)).toBe("verdict");
  });

  it("rejects entry kinds outside the probe vocabulary", () => {
    const dir = fresh();
    const { id } = startSession(dir, "probe", "x", "GH-1");
    expect(() => appendSession(dir, "probe", id, "hypothesis", "nope")).toThrow(/entry kind/);
  });

  it("close gate: refuses without a verdict, closes with one, archives immutably", () => {
    const dir = fresh();
    const { id } = startSession(dir, "probe", "y", "GH-2");
    appendSession(dir, "probe", id, "experiment", "e1");
    expect(() => closeSession(dir, "probe", id, "stop — dead end")).toThrow(/verdict/);
    appendSession(dir, "probe", id, "verdict", "INVALIDATED — API caps at 10rps");
    const out = closeSession(dir, "probe", id, "stop — API rate cap kills the approach");
    expect(out.gateTexts).toEqual(["INVALIDATED — API caps at 10rps"]);
    expect(existsSync(out.archivePath)).toBe(true);
    expect(existsSync(join(dir, ".cairn", "probe", `${id}.md`))).toBe(false);
    expect(() => appendSession(dir, "probe", id, "experiment", "late")).toThrow(/immutable|resolved/);
  });

  it("resolution text is readable from the archive", () => {
    const dir = fresh();
    const { id } = startSession(dir, "probe", "z", "GH-3");
    appendSession(dir, "probe", id, "verdict", "VALIDATED");
    closeSession(dir, "probe", id, "proceed — approach holds");
    expect(sessionResolution(dir, "probe", id)).toBe("proceed — approach holds");
    expect(listSessions(dir, "probe", "resolved")[0].status).toBe("resolved");
  });
});

describe("sessions store — draft kind", () => {
  it("draft vocabulary and decision gate", () => {
    const dir = fresh();
    const { id } = startSession(dir, "draft", "dashboard layout", "GH-5");
    appendSession(dir, "draft", id, "variant", "001-cards.html — card grid");
    appendSession(dir, "draft", id, "note", "user leans dense");
    expect(() => closeSession(dir, "draft", id, "cards it is")).toThrow(/decision/);
    appendSession(dir, "draft", id, "decision", "card grid, dense spacing");
    const out = closeSession(dir, "draft", id, "card grid direction locked");
    expect(out.gateTexts).toEqual(["card grid, dense spacing"]);
  });

  it("kinds are isolated: a draft id never lists under probe", () => {
    const dir = fresh();
    startSession(dir, "draft", "isolated", "GH-6");
    expect(listSessions(dir, "probe")).toEqual([]);
    expect(listSessions(dir, "draft")).toHaveLength(1);
  });
});
