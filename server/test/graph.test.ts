// Pure graph functions — fixtures are plain Issue/IssueLink literals; the
// module must work identically against any hasDependencies backend.

import { describe, it, expect } from "vitest";
import { danglingEdges, effectivePriorities, lineage, readyFrontier } from "../src/tracker/graph.js";
import type { Issue, IssueLink } from "../src/tracker/types.js";

const issue = (id: string, state: Issue["state"] = "open", labels: string[] = []): Issue =>
  ({ id, title: id, body: "", state, labels, updatedAt: "2026-07-26T00:00:00Z", url: `x://${id}` });

const L = (from: string, type: IssueLink["type"], to: string): IssueLink => ({ from, type, to });

describe("readyFrontier", () => {
  it("open issues with no open blockers; closed blockers unblock", () => {
    const issues = [issue("a", "closed"), issue("b"), issue("c"), issue("d", "in_progress")];
    const links = [L("a", "blocks", "b"), L("c", "blocks", "d"), L("b", "blocks", "c")];
    // b: blocker a closed → ready. c: blocker b open → not ready. d: in_progress → not listed.
    expect(readyFrontier(issues, links).map((i) => i.id)).toEqual(["b"]);
  });

  it("ignores non-blocking edge types", () => {
    const issues = [issue("a"), issue("b")];
    expect(readyFrontier(issues, [L("a", "relates-to", "b")]).map((i) => i.id).sort())
      .toEqual(["a", "b"]);
  });
});

describe("effectivePriorities", () => {
  it("an issue inherits the strongest priority it transitively blocks", () => {
    const issues = [
      issue("low", "open", ["priority:P3"]),
      issue("mid", "open"),
      issue("high", "open", ["priority:P1"]),
    ];
    const links = [L("low", "blocks", "mid"), L("mid", "blocks", "high")];
    const out = effectivePriorities(issues, links);
    expect(out).toContainEqual({ id: "low", declared: "P3", effective: "P1", inheritedFrom: "high" });
    expect(out).toContainEqual({ id: "mid", declared: undefined, effective: "P1", inheritedFrom: "high" });
    expect(out.find((e) => e.id === "high")).toBeUndefined(); // unchanged → not reported
  });

  it("closed downstream issues confer nothing", () => {
    const issues = [issue("a", "open", ["priority:P3"]), issue("b", "closed", ["priority:P0"])];
    expect(effectivePriorities(issues, [L("a", "blocks", "b")])).toEqual([]);
  });
});

describe("lineage", () => {
  it("walks supersedes both directions, oldest first", () => {
    const issues = [issue("v1", "closed"), issue("v2", "closed"), issue("v3")];
    const links = [L("v2", "supersedes", "v1"), L("v3", "supersedes", "v2")];
    expect(lineage(issues, links, "v2")).toEqual(["v1", "v2", "v3"]);
  });

  it("no supersedes edges → just the issue itself", () => {
    expect(lineage([issue("solo")], [], "solo")).toEqual(["solo"]);
  });
});

describe("danglingEdges", () => {
  it("flags links whose endpoints no longer exist", () => {
    const links = [L("a", "blocks", "gone"), L("a", "relates-to", "b")];
    expect(danglingEdges([issue("a"), issue("b")], links))
      .toEqual([L("a", "blocks", "gone")]);
  });
});
