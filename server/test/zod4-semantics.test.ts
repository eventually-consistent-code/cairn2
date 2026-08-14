/**
 * Purpose: zod-4 behavior-diff regression net (#95). zod 4's .default(v)
 * short-circuits (returns v without applying inner defaults) where zod 3
 * parsed the default through; enum-keyed records went exhaustive. These
 * tests pin every load-bearing surface that depended on zod-3 semantics
 * so a future zod bump that shifts them again fails loudly here, with the
 * defect named, instead of surfacing as a mystery CONFIG_INVALID mid-verb.
 * Author(s): John Reed
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { CairnError } from "../src/errors.js";
import { configSchema as clickupSchema } from "../src/tracker/adapters/clickup.js";
import { configSchema as jiraSchema } from "../src/tracker/adapters/jira.js";
import { configSchema as azureSchema } from "../src/tracker/adapters/azure-boards.js";
import { configSchema as localSchema } from "../src/tracker/adapters/local.js";
import { mapSet, mapGet } from "../src/map/store.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-zod4-"));

// Seeds a temp project with a cairn.json and hands the dir back.
function seed(obj: Record<string, unknown>): string {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify(obj));
  return d;
}

const MINIMAL = { tracker: { type: "github", config: { repo: "o/r" } } };

describe("config defaults round-trip (.prefault parse-through)", () => {
  it("minimal cairn.json fills every nested default — the zod-4 .default({}) short-circuit would leave these blocks empty", () => {
    const cfg = loadConfig(seed(MINIMAL));
    // continuity block absent → .prefault({}) parses through and applies
    // every inner default, two levels deep.
    expect(cfg.continuity).toEqual({
      resume: "prompt",
      checkpoint: true,
      wipCommits: false,
      recallIndex: { enabled: true, maxCards: 20 },
    });
    expect(cfg.leakGuard).toEqual({ enabled: true, allow: [], extraPatterns: [] });
    expect(cfg.ship).toEqual({ confirm: true });
    // Non-empty .default values stay complete-by-construction.
    expect(cfg.agents).toEqual({ model: "auto" });
    expect(cfg.memory).toEqual({ tokenThreshold: 150000 });
  });

  it("partial nested block merges with inner defaults instead of replacing them", () => {
    const cfg = loadConfig(seed({
      ...MINIMAL,
      continuity: { resume: "off", recallIndex: { maxCards: 5 } },
      leakGuard: { allow: ["docs/**"] },
    }));
    expect(cfg.continuity.resume).toBe("off");
    expect(cfg.continuity.checkpoint).toBe(true);
    expect(cfg.continuity.recallIndex).toEqual({ enabled: true, maxCards: 5 });
    expect(cfg.leakGuard).toEqual({
      enabled: true,
      allow: ["docs/**"],
      extraPatterns: [],
    });
  });

  it("defaults are fresh per parse — mutating one load never bleeds into the next", () => {
    const a = loadConfig(seed(MINIMAL));
    const b = loadConfig(seed(MINIMAL));
    a.leakGuard.allow.push("mutated/**");
    expect(b.leakGuard.allow).toEqual([]);
  });
});

describe("peers partial record (enum-keyed, non-exhaustive)", () => {
  it("naming one provider parses — zod 4's exhaustive record would demand all four", () => {
    const cfg = loadConfig(seed({
      ...MINIMAL,
      peers: { codex: { enabled: false } },
    }));
    expect(cfg.peers).toEqual({ codex: { enabled: false } });
  });

  it("unknown provider key still fails CONFIG_INVALID", () => {
    expect(() => loadConfig(seed({ ...MINIMAL, peers: { gemini: {} } })))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("tracker adapter status-map defaults (whole-map replace, refine guard)", () => {
  const clickupBase = { defaultListId: "900", folderId: "f1" };

  it("clickup: absent statuses → full default map", () => {
    const c = clickupSchema.parse(clickupBase);
    expect(c.statuses).toEqual({
      open: "to do",
      in_progress: "in progress",
      closed: "complete",
    });
  });

  it("clickup: partial statuses map is rejected, not merged", () => {
    expect(() => clickupSchema.parse({ ...clickupBase, statuses: { open: "x" } }))
      .toThrowError(/statuses must include/);
  });

  it("clickup: full custom map with an extra state passes verbatim", () => {
    const statuses = {
      open: "backlog", in_progress: "doing", closed: "done", review: "code review",
    };
    expect(clickupSchema.parse({ ...clickupBase, statuses }).statuses)
      .toEqual(statuses);
  });

  it("jira: absent transitions → defaults; partial rejected", () => {
    const base = { baseUrl: "https://x.atlassian.net", projectKey: "CRN" };
    expect(jiraSchema.parse(base).transitions)
      .toEqual({ in_progress: "In Progress", closed: "Done" });
    expect(() => jiraSchema.parse({ ...base, transitions: { closed: "Done" } }))
      .toThrowError(/transitions must include/);
  });

  it("azure-boards: absent states → defaults; partial rejected", () => {
    const base = { orgUrl: "https://dev.azure.com/org", project: "p" };
    expect(azureSchema.parse(base).states)
      .toEqual({ in_progress: "Doing", closed: "Done", open: "To Do" });
    expect(() => azureSchema.parse({ ...base, states: { open: "New" } }))
      .toThrowError(/states must include/);
  });

  it("local: absent states → {}; custom names keep string keys; bad category rejected", () => {
    expect(localSchema.parse({}).states).toEqual({});
    expect(localSchema.parse({ states: { review: "in_progress" } }).states)
      .toEqual({ review: "in_progress" });
    expect(() => localSchema.parse({ states: { review: "reviewing" } }))
      .toThrow();
  });
});

describe("map store parse (string-keyed record)", () => {
  it("round-trips nodes under arbitrary ids", () => {
    const d = dir();
    mapSet(d, {
      nodes: {
        "srv/config": { type: "module", label: "config loader" },
        "issue-95": { type: "issue", label: "zod-4 sweep" },
      },
      edgesAdd: [{ from: "issue-95", to: "srv/config", type: "depends-on" }],
    });
    const map = mapGet(d);
    expect(Object.keys(map.nodes).sort()).toEqual(["issue-95", "srv/config"]);
    expect(map.edges).toHaveLength(1);
  });

  it("hand-edited map.json with a defective node fails loudly at read", () => {
    const d = dir();
    mkdirSync(join(d, ".cairn", "map"), { recursive: true });
    writeFileSync(
      join(d, ".cairn", "map", "map.json"),
      JSON.stringify({ nodes: { bad: { type: "module" } }, edges: [] }),
    );
    expect(() => mapGet(d)).toThrowError(CairnError);
  });
});
