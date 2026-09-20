import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture tests -- the layering docs/ARCHITECTURE.md states, asserted
 * instead of merely written down. Documentation decays; a rule that runs on
 * every push does not.
 *
 * The discipline that makes these worth having: EVERY rule fails when its
 * file pattern matches nothing. A rule that inspected zero files and passed
 * is worse than no rule at all, because it reads as coverage forever -- one
 * renamed directory and the guard silently guards nothing. The same applies
 * to each allowlist entry below: an exception nobody uses any more is rot,
 * so unused entries fail too and have to be deleted deliberately.
 *
 * Deliberately NOT asserted: that peer subsystems don't import each other.
 * They do, extensively and legitimately (planning reads the tracker, audit
 * reads planning). Writing that rule would mean weakening it until it said
 * nothing. What IS asserted is the set of boundaries the design actually
 * depends on.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every .ts file under server/src, as paths relative to src (POSIX). */
function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".ts")) out.push(relative(SRC, p).split("\\").join("/"));
    }
  })(SRC);
  return out.sort();
}

/**
 * Relative import targets of one file, as extensionless paths relative to
 * src. Package imports (zod, node:*) are not layering concerns and are
 * dropped. `.js` specifiers are how TypeScript's NodeNext resolution spells
 * a sibling .ts file -- normalise them away so rules read in source terms.
 */
function importsOf(file: string): string[] {
  const src = readFileSync(join(SRC, file), "utf8");
  const targets: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s+"(\.[^"]+)"/g)) {
    const abs = resolve(dirname(join(SRC, file)), m[1]).replace(/\.js$/, "");
    targets.push(relative(SRC, abs).split("\\").join("/"));
  }
  return targets;
}

/** The subsystem a src-relative path belongs to; files directly in src are "(root)". */
function subsystemOf(path: string): string {
  return path.includes("/") ? path.split("/")[0] : "(root)";
}

const FILES = sourceFiles();

/**
 * Selects the files a rule applies to and refuses to run on an empty set.
 * This is the anti-vacuous check, centralised so no rule can skip it.
 */
function filesMatching(predicate: (f: string) => boolean, label: string): string[] {
  const matched = FILES.filter(predicate);
  expect(matched.length, `rule matched ZERO files (${label}) — the pattern is stale, ` +
    "so this rule has been silently guarding nothing").toBeGreaterThan(0);
  return matched;
}

describe("architecture: the server's layering is enforced, not just documented", () => {
  it("finds the source tree at all", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain("index.ts");
  });

  it("tracker adapters are leaves — nothing outside the tracker subsystem", () => {
    const adapters = filesMatching((f) => f.startsWith("tracker/adapters/"),
      "tracker/adapters/**");
    const violations: string[] = [];
    for (const f of adapters) {
      for (const t of importsOf(f)) {
        const sub = subsystemOf(t);
        if (sub !== "tracker" && sub !== "(root)") violations.push(`${f} -> ${t}`);
      }
    }
    expect(violations, "an adapter reaching into another subsystem breaks the SPI: " +
      "adapters implement the contract, they do not consume the rest of the server")
      .toEqual([]);
  });

  it("the tracker subsystem sits underneath the peers that use it", () => {
    const tracker = filesMatching((f) => f.startsWith("tracker/"), "tracker/**");
    // Planning, audit, docs and friends all read the tracker. The tracker
    // reading THEM would make the dependency mutual and the SPI a fiction.
    const PEERS = ["planning", "audit", "seats", "sessions", "trace", "memory",
      "map", "peers", "research", "workspace", "docs"];
    const violations: string[] = [];
    for (const f of tracker) {
      for (const t of importsOf(f)) {
        if (PEERS.includes(subsystemOf(t))) violations.push(`${f} -> ${t}`);
      }
    }
    expect(violations, "the tracker subsystem must not depend on the subsystems that " +
      "depend on it — that is the difference between a layer and a tangle").toEqual([]);
  });

  /**
   * The docs connectors are documented as a SIBLING of the tracker subsystem,
   * not an extension of it — yet they legitimately reuse its HTTP, probe and
   * error-mapping plumbing. That plumbing is misplaced rather than the import
   * being wrong, so the exception is named here instead of the rule being
   * watered down. Each entry must actually be used (see the rot check below).
   */
  const DOCS_MAY_REUSE_FROM_TRACKER = [
    "tracker/http",
    "tracker/probe",
    "tracker/types",
    "tracker/registry",
  ];

  it("docs connectors reuse only the tracker's named transport plumbing", () => {
    const docs = filesMatching((f) => f.startsWith("docs/"), "docs/**");
    const violations: string[] = [];
    for (const f of docs) {
      for (const t of importsOf(f)) {
        if (subsystemOf(t) !== "tracker") continue;
        if (!DOCS_MAY_REUSE_FROM_TRACKER.includes(t)) violations.push(`${f} -> ${t}`);
      }
    }
    expect(violations, "docs is a sibling subsystem: it may share the tracker's transport " +
      "plumbing, never its work-item logic or its adapters. A new import here is a " +
      "decision, so make it deliberately — widen the list or move the shared module.")
      .toEqual([]);
  });

  it("every named exception is still used — a dead allowlist entry is rot", () => {
    const docs = FILES.filter((f) => f.startsWith("docs/"));
    const used = new Set(docs.flatMap(importsOf));
    const dead = DOCS_MAY_REUSE_FROM_TRACKER.filter((e) => !used.has(e));
    expect(dead, "these exceptions are no longer needed — delete them so the rule " +
      "tightens as the code improves").toEqual([]);
  });

  it("index.ts is the composition root — nothing imports it back", () => {
    const importers = FILES.filter((f) => f !== "index.ts" && importsOf(f).includes("index"));
    expect(importers, "the composition root wires subsystems together; a subsystem " +
      "importing it inverts that and creates a cycle through the whole server").toEqual([]);
  });

  it("has no import cycles anywhere under src", () => {
    const known = new Set(FILES.map((f) => f.replace(/\.ts$/, "")));
    const graph = new Map<string, string[]>();
    for (const f of FILES) {
      graph.set(f.replace(/\.ts$/, ""),
        importsOf(f).filter((t) => known.has(t)));
    }
    expect(graph.size, "cycle check built an empty graph").toBeGreaterThan(50);

    const state = new Map<string, "open" | "done">();
    const cycles: string[] = [];
    const visit = (node: string, stack: string[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "open") {
        cycles.push([...stack.slice(stack.indexOf(node)), node].join(" -> "));
        return;
      }
      state.set(node, "open");
      for (const next of graph.get(node) ?? []) visit(next, [...stack, node]);
      state.set(node, "done");
    };
    for (const node of graph.keys()) visit(node, []);

    expect(cycles, "an import cycle makes module init order load-bearing and " +
      "un-reviewable — break it where the dependency is weakest").toEqual([]);
  });
});
