import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIND_SPECS, appendSession, closeSession, lastSessionEntry, listSessions,
  sessionId, sessionLandscape, sessionResolution, startSession,
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

describe("sessionLandscape", () => {
  it("joins all kinds, carries archived resolutions, groups phases, deterministic", () => {
    const dir = fresh();
    const p = startSession(dir, "probe", "dead end", "GH-10", "2");
    appendSession(dir, "probe", p.id, "verdict", "INVALIDATED");
    closeSession(dir, "probe", p.id, "stop — SDK cannot stream");
    startSession(dir, "draft", "layout", "GH-11", "2");
    startSession(dir, "trace", "bug", "GH-12");

    const scape = sessionLandscape(dir);
    expect(scape.openByKind).toEqual({ trace: 1, probe: 0, draft: 1, thread: 0 });
    const stopped = scape.sessions.find((s) => s.id === p.id);
    expect(stopped?.status).toBe("resolved");
    expect(stopped?.resolution).toBe("stop — SDK cannot stream");
    expect(scape.phases).toEqual([{ phase: "2", sessions: expect.arrayContaining([p.id]) }]);
    // deterministic: kind order trace,probe,draft then id
    expect(JSON.stringify(sessionLandscape(dir))).toBe(JSON.stringify(scape));
    expect(scape.sessions.map((s) => s.kind)).toEqual(["trace", "probe", "draft"]);
  });
});

describe("sessions store — thread kind", () => {
  it("thread vocabulary, wrap gate, archive", () => {
    const dir = fresh();
    const { id } = startSession(dir, "thread", "payments refactor", "GH-60", "4");
    expect(id.startsWith("thread-")).toBe(true);
    appendSession(dir, "thread", id, "note", "stripe adapter first");
    appendSession(dir, "thread", id, "link", "probe-ab12cd34 — proved streaming holds");
    appendSession(dir, "thread", id, "decision", "webhooks over polling");
    expect(() => appendSession(dir, "thread", id, "evidence", "nope")).toThrow(/entry kind/);
    expect(() => closeSession(dir, "thread", id, "done")).toThrow(/wrap/);
    appendSession(dir, "thread", id, "wrap", "landed: adapter migrated, webhooks live");
    const out = closeSession(dir, "thread", id, "refactor thread wrapped — see wrap entry");
    expect(out.gateTexts).toEqual(["landed: adapter migrated, webhooks live"]);
    expect(listSessions(dir, "thread", "resolved")[0].phase).toBe("4");
  });

  it("landscape includes threads last in kind order", () => {
    const dir = fresh();
    startSession(dir, "thread", "t", "GH-61");
    startSession(dir, "trace", "b", "GH-62");
    expect(sessionLandscape(dir).sessions.map((s) => s.kind)).toEqual(["trace", "thread"]);
    expect(sessionLandscape(dir).openByKind).toEqual({ trace: 1, probe: 0, draft: 0, thread: 1 });
  });
});
