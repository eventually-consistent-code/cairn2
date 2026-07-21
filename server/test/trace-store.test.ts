import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTrace, appendTrace, listTraces, closeTrace, traceId,
} from "../src/trace/store.js";

describe("trace store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cairn-tr-")); });

  it("start writes frontmatter + title; id is description-hashed", () => {
    const { id, path } = startTrace(dir, "index breaks past 64KB", "GH-12");
    expect(id).toBe(traceId("index breaks past 64KB"));
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("status: open");
    expect(raw).toContain("issue: GH-12");
    expect(raw).toContain("# Trace: index breaks past 64KB");
  });

  it("duplicate open start is refused", () => {
    startTrace(dir, "same bug", "GH-1");
    expect(() => startTrace(dir, "same bug", "GH-2")).toThrowError(/already open/);
  });

  it("append is append-only: prior bytes untouched, blocks accumulate", () => {
    const { id, path } = startTrace(dir, "b", "GH-1");
    appendTrace(dir, id, "evidence", "fails only over 64KB");
    const after1 = readFileSync(path, "utf8");
    appendTrace(dir, id, "hypothesis", "off-by-one at page edge");
    const after2 = readFileSync(path, "utf8");
    expect(after2.startsWith(after1)).toBe(true);
    expect(after2).toContain("## evidence — ");
    expect(after2).toContain("## hypothesis — ");
  });

  it("list reports counts and both statuses", () => {
    const { id } = startTrace(dir, "b1", "GH-1");
    appendTrace(dir, id, "evidence", "e");
    appendTrace(dir, id, "verdict", "v");
    const open = listTraces(dir, "open");
    expect(open.length).toBe(1);
    expect(open[0].entryCounts.evidence).toBe(1);
    expect(open[0].entryCounts.verdict).toBe(1);
    expect(open[0].description).toBe("b1");
  });

  it("close without a verdict is refused; with one it archives + stamps", () => {
    const { id } = startTrace(dir, "b2", "GH-3");
    appendTrace(dir, id, "evidence", "e");
    expect(() => closeTrace(dir, id, "done")).toThrowError(/verdict/);
    appendTrace(dir, id, "verdict", "root cause: X; fixed in abc1234");
    const out = closeTrace(dir, id, "fixed the pagination");
    expect(out.verdicts).toEqual(["root cause: X; fixed in abc1234"]);
    expect(existsSync(out.archivePath)).toBe(true);
    expect(readFileSync(out.archivePath, "utf8")).toContain("status: resolved");
    expect(listTraces(dir, "open").length).toBe(0);
    expect(listTraces(dir, "resolved").length).toBe(1);
  });

  it("append to resolved or unknown trace is refused", () => {
    const { id } = startTrace(dir, "b3", "GH-4");
    appendTrace(dir, id, "verdict", "v");
    closeTrace(dir, id, "r");
    expect(() => appendTrace(dir, id, "evidence", "late")).toThrowError(/resolved/);
    expect(() => appendTrace(dir, "trace-00000000", "evidence", "x")).toThrowError(/no trace/);
  });
});
