import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveContext } from "../src/active-context.js";

describe("ActiveContext", () => {
  it("starts empty, sets and clears fields, persists across instances", () => {
    const d = mkdtempSync(join(tmpdir(), "cairn-"));
    const a = new ActiveContext(d);
    expect(a.get()).toEqual({});
    a.set({ phase: 3, issueId: "PROJ-107" });
    expect(a.get()).toEqual({ phase: 3, issueId: "PROJ-107" });
    a.set({ issueId: null });
    expect(a.get()).toEqual({ phase: 3 });
    const b = new ActiveContext(d); // fresh instance reads the file
    expect(b.get()).toEqual({ phase: 3 });
  });
});
