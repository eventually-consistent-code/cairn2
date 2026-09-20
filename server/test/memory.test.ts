import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OBSERVATION_WARN_THRESHOLD,
  observationBacklog,
  observationThreshold,
  observationsPath,
} from "../src/memory/observations.js";
import { renderBanner } from "../src/memory/banner.js";
import { bannerPath } from "../src/core/continuity.js";
import { createCard } from "../src/memory/cards.js";

/**
 * #173 — the observation buffer announcing its own state, through mem_stats'
 * `observations` block and the session banner's "run retro" line.
 */

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cairn-observations-"));
  dirs.push(d);
  return d;
};

/** A registered project, optionally with a custom warn threshold. */
const registered = (warnAt?: number) => {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify({
    tracker: { type: "github", config: { repo: "o/r" } },
    ...(warnAt === undefined ? {} : { memory: { tokenThreshold: 150000, observationWarnThreshold: warnAt } }),
  }));
  return d;
};

const DAY_MS = 86_400_000;

/** Writes `rows` observation lines, the oldest `ageDays` old, newest at `now`. */
function seedObservations(projectDir: string, rows: number, ageDays = 0, now = Date.now()): void {
  const path = observationsPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    // First row is the oldest; the rest march forward an hour at a time.
    const ts = new Date(now - ageDays * DAY_MS + i * 3_600_000).toISOString();
    lines.push(JSON.stringify({ ts, session_id: "s", tool: "Edit", target: "src/x.ts", error: false }));
  }
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(bannerPath(d), { force: true });
    rmSync(d, { recursive: true, force: true });
  }
});

describe("observationBacklog", () => {
  it("reports an empty backlog when the buffer file does not exist", () => {
    const d = registered();
    expect(observationBacklog(d)).toEqual({
      count: 0, oldest: null, oldestAgeDays: 0, threshold: 25, overThreshold: false,
    });
  });

  it("counts rows and ages the oldest one in whole days", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    seedObservations(d, 4, 6, now);
    const backlog = observationBacklog(d, now);
    expect(backlog.count).toBe(4);
    expect(backlog.oldest).toBe(new Date(now - 6 * DAY_MS).toISOString());
    expect(backlog.oldestAgeDays).toBe(6);
  });

  it("ages the oldest row even when the file is not in chronological order", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    const path = observationsPath(d);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({ ts: new Date(now - 1 * DAY_MS).toISOString(), tool: "Bash" }),
      JSON.stringify({ ts: new Date(now - 9 * DAY_MS).toISOString(), tool: "Bash" }),
      JSON.stringify({ ts: new Date(now - 3 * DAY_MS).toISOString(), tool: "Bash" }),
    ].join("\n") + "\n");
    expect(observationBacklog(d, now).oldestAgeDays).toBe(9);
  });

  it("counts a row it cannot parse but takes no age from it", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    const path = observationsPath(d);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      "{\"ts\": \"2026-09-1",                                                  // killed mid-write
      JSON.stringify({ ts: new Date(now - 2 * DAY_MS).toISOString(), tool: "Edit" }),
      JSON.stringify({ ts: 17, tool: "Edit" }),                                // wrong type
      JSON.stringify({ ts: "not-a-date", tool: "Edit" }),
      "",                                                                      // trailing newline
    ].join("\n"));
    const backlog = observationBacklog(d, now);
    expect(backlog.count).toBe(4);
    expect(backlog.oldestAgeDays).toBe(2);
  });

  it("never reports a negative age for a row written with clock skew", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    seedObservations(d, 1, -1, now); // one day into the future
    expect(observationBacklog(d, now).oldestAgeDays).toBe(0);
  });

  it("is over threshold at exactly the threshold, not one past it", () => {
    const d = registered(3);
    seedObservations(d, 2);
    expect(observationBacklog(d).overThreshold).toBe(false);
    seedObservations(d, 3);
    expect(observationBacklog(d).overThreshold).toBe(true);
  });
});

describe("observationThreshold", () => {
  it("defaults to the shipped threshold when cairn.json omits the key", () => {
    expect(observationThreshold(registered())).toBe(OBSERVATION_WARN_THRESHOLD);
    expect(OBSERVATION_WARN_THRESHOLD).toBe(25);
  });

  it("honors an explicit memory.observationWarnThreshold", () => {
    expect(observationThreshold(registered(5))).toBe(5);
  });

  it("falls back to the default for an unregistered project instead of throwing", () => {
    // The backlog warning must survive exactly the conditions that break
    // everything else -- no cairn.json is not a reason to go quiet.
    expect(observationThreshold(dir())).toBe(OBSERVATION_WARN_THRESHOLD);
  });
});

describe("recall banner — observation backlog", () => {
  it("banner says nothing about observations below the threshold", () => {
    const d = registered(10);
    createCard(d, { type: "decision", body: "project-wide decision" });
    seedObservations(d, 9);
    expect(renderBanner(d)!).not.toContain("run retro");
  });

  it("banner flags the count and the oldest age past the threshold", () => {
    const d = registered(3);
    createCard(d, { type: "decision", body: "project-wide decision" });
    seedObservations(d, 42, 6);
    expect(renderBanner(d)!).toContain("**42 unreviewed observations (oldest 6d) — run retro**");
  });

  it("banner renders on the backlog alone, with no cards and no open sessions", () => {
    const d = registered(3);
    seedObservations(d, 30, 2);
    const rendered = renderBanner(d);
    expect(rendered).not.toBeNull();
    expect(rendered!).toContain("## cairn recall index — ");
    expect(rendered!).toContain("**30 unreviewed observations (oldest 2d) — run retro**");
    // Nothing else to show -- no card table headers.
    expect(rendered!).not.toContain("| id | type | title | fetch cost |");
  });

  it("banner puts the warning directly under the header, above the card table", () => {
    const d = registered(3);
    createCard(d, { type: "gotcha", body: "GitHub 403 means throttle, not just auth" });
    seedObservations(d, 5, 1);
    const lines = renderBanner(d)!.split("\n");
    expect(lines[0]).toContain("## cairn recall index — ");
    expect(lines[1]).toBe("**5 unreviewed observations (oldest 1d) — run retro**");
    expect(lines[2]).toBe("| id | type | title | fetch cost |");
  });

  it("banner singularizes a lone observation", () => {
    const d = registered(1);
    seedObservations(d, 1, 0);
    expect(renderBanner(d)!).toContain("**1 unreviewed observation (oldest 0d) — run retro**");
  });

  it("banner stays silent when the recall index is disabled, backlog or not", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      memory: { tokenThreshold: 150000, observationWarnThreshold: 3 },
      continuity: { recallIndex: { enabled: false } },
    }));
    seedObservations(d, 50, 9);
    expect(renderBanner(d)).toBeNull();
  });
});
