import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boardGet, boardUpdate } from "../src/workspace/board.js";
import { CairnError } from "../src/errors.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-board-"));

function writeWorkspace(root: string, workspace: string, members: Array<{ name: string; path: string }>): void {
  writeFileSync(join(root, "cairn-workspace.json"), JSON.stringify({ workspace, members }, null, 2));
}

function configureMember(root: string, relPath: string): void {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cairn.json"), JSON.stringify({ tracker: { type: "github", config: {} } }));
}

/** A ready two-member workspace (api, web), both configured. */
function freshWorkspace(): string {
  const root = fresh();
  writeWorkspace(root, "acme", [{ name: "api", path: "api" }, { name: "web", path: "web" }]);
  configureMember(root, "api");
  configureMember(root, "web");
  return root;
}

describe("boardUpdate", () => {
  it("creates a new workstream, stamping 'updated' server-side", () => {
    const root = freshWorkspace();
    const out = boardUpdate(root, {
      "ws-1": { title: "migrate api auth", project: "api", status: "queued" },
    });
    expect(out).toEqual({ workstreams: 1 });
    const board = boardGet(root);
    expect(board.workstreams["ws-1"]).toEqual({
      title: "migrate api auth", project: "api", status: "queued",
      updated: new Date().toISOString().slice(0, 10),
    });
  });

  it("merges a patch's fields over an existing workstream, leaving other fields intact", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api", status: "queued" } });
    boardUpdate(root, { "ws-1": { status: "active", session: "session-a" } });
    const board = boardGet(root);
    expect(board.workstreams["ws-1"]).toEqual({
      title: "migrate api auth", project: "api", status: "active", session: "session-a",
      updated: new Date().toISOString().slice(0, 10),
    });
  });

  it("null deletes a workstream", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api", status: "queued" } });
    const out = boardUpdate(root, { "ws-1": null });
    expect(out).toEqual({ workstreams: 0 });
    expect(boardGet(root).workstreams).toEqual({});
  });

  it("requires title and project on create, naming the id", () => {
    const root = freshWorkspace();
    expect(() => boardUpdate(root, { "ws-1": { status: "queued" } })).toThrow(/ws-1/);
  });

  it("does not require title or project again on update", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api", status: "queued" } });
    expect(() => boardUpdate(root, { "ws-1": { note: "blocked on infra" } })).not.toThrow();
    expect(boardGet(root).workstreams["ws-1"].note).toBe("blocked on infra");
  });

  it("rejects an invalid status", () => {
    const root = freshWorkspace();
    expect(() => boardUpdate(root, {
      "ws-1": { title: "migrate api auth", project: "api", status: "in-progress" as never },
    })).toThrow(/ws-1/);
  });

  it("rejects a project that is not a workspace member", () => {
    const root = freshWorkspace();
    expect(() => boardUpdate(root, {
      "ws-1": { title: "migrate api auth", project: "ghost", status: "queued" },
    })).toThrow(/ghost/);
  });

  it("rejects with PRECONDITION_FAILED when no workspace exists, hinting basecamp init", () => {
    const dir = fresh();
    try {
      boardUpdate(dir, { "ws-1": { title: "t", project: "api", status: "queued" } });
      throw new Error("expected boardUpdate to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("PRECONDITION_FAILED");
      expect((e as CairnError).nextAction).toContain("basecamp init");
    }
  });

  it("leaves the store untouched when a patch is rejected (validate-before-write)", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api", status: "queued" } });
    expect(() => boardUpdate(root, {
      "ws-1": { status: "active" },
      "ws-2": { title: "bad", project: "ghost", status: "queued" },
    })).toThrow(/ghost/);
    const board = boardGet(root);
    expect(board.workstreams).toEqual({
      "ws-1": {
        title: "migrate api auth", project: "api", status: "queued",
        updated: new Date().toISOString().slice(0, 10),
      },
    });
  });

  it("writes atomically -- no leftover .tmp file after a successful write", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api", status: "queued" } });
    expect(existsSync(join(root, ".cairn", "basecamp", "board.json"))).toBe(true);
    expect(existsSync(join(root, ".cairn", "basecamp", "board.json.tmp"))).toBe(false);
  });

  it("rejects an empty title on create, naming the id", () => {
    const root = freshWorkspace();
    expect(() => boardUpdate(root, { "ws-1": { title: "", project: "api", status: "queued" } })).toThrow(/ws-1/);
  });

  it("rejects a whitespace-only title on update, leaving store untouched", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api", status: "queued" } });
    expect(() => boardUpdate(root, { "ws-1": { title: "   " } })).toThrow(/ws-1/);
    const board = boardGet(root);
    expect(board.workstreams["ws-1"].title).toBe("migrate api auth");
  });

  it("defaults status to queued when omitted on create", () => {
    const root = freshWorkspace();
    boardUpdate(root, { "ws-1": { title: "migrate api auth", project: "api" } });
    const board = boardGet(root);
    expect(board.workstreams["ws-1"].status).toBe("queued");
  });
});

describe("boardGet", () => {
  it("returns an empty board with zeroed counts when no board file exists yet", () => {
    const root = freshWorkspace();
    expect(boardGet(root)).toEqual({
      workstreams: {},
      counts: { queued: 0, active: 0, blocked: 0, done: 0 },
    });
  });

  it("rejects with PRECONDITION_FAILED when no workspace exists", () => {
    const dir = fresh();
    expect(() => boardGet(dir)).toThrow(CairnError);
    try {
      boardGet(dir);
    } catch (e) {
      expect((e as CairnError).code).toBe("PRECONDITION_FAILED");
    }
  });

  it("sorts workstream ids deterministically and is byte-stable across reads", () => {
    const root = freshWorkspace();
    boardUpdate(root, {
      "ws-z": { title: "z", project: "api", status: "queued" },
      "ws-a": { title: "a", project: "web", status: "active" },
      "ws-m": { title: "m", project: "api", status: "blocked" },
    });
    const first = boardGet(root);
    expect(Object.keys(first.workstreams)).toEqual(["ws-a", "ws-m", "ws-z"]);
    const second = boardGet(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("derives counts by status", () => {
    const root = freshWorkspace();
    boardUpdate(root, {
      "ws-1": { title: "a", project: "api", status: "queued" },
      "ws-2": { title: "b", project: "api", status: "queued" },
      "ws-3": { title: "c", project: "web", status: "active" },
      "ws-4": { title: "d", project: "web", status: "done" },
    });
    expect(boardGet(root).counts).toEqual({ queued: 2, active: 1, blocked: 0, done: 1 });
  });
});
