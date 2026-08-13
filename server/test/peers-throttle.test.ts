import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concurrencyBudget } from "../src/peers/throttle.js";
import { loadConfig } from "../src/config.js";

const MB750 = 750 * 1024 * 1024;
const GB = 1024 * 1024 * 1024;

const dir = () => mkdtempSync(join(tmpdir(), "cairn-throttle-"));

// Seeds a temp project dir with a cairn.json built from obj.
function writeTmpConfig(obj: Record<string, unknown>): string {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify(obj));
  return d;
}

describe("concurrencyBudget", () => {
  it("caps at 8 even with abundant memory and cores", () => {
    expect(concurrencyBudget({ freeMemBytes: 64 * GB, cores: 32 })).toBe(8);
  });

  it("4 cores with 8GB free budgets 3 seats (cores - 1 binds)", () => {
    expect(concurrencyBudget({ freeMemBytes: 8 * GB, cores: 4 })).toBe(3);
  });

  it("memory binds when scarcer than cores: 16 cores, 2 seats of RAM", () => {
    expect(concurrencyBudget({ freeMemBytes: 2 * MB750, cores: 16 })).toBe(2);
  });

  it("scarce memory floors at 1 — never zero seats", () => {
    expect(concurrencyBudget({ freeMemBytes: 500 * 1024 * 1024, cores: 8 })).toBe(1);
  });

  it("a single core still floors at 1", () => {
    expect(concurrencyBudget({ freeMemBytes: 8 * GB, cores: 1 })).toBe(1);
  });

  it("explicit override wins entirely, even above the natural budget", () => {
    expect(concurrencyBudget({ freeMemBytes: 8 * GB, cores: 4, override: 12 })).toBe(12);
    expect(concurrencyBudget({ freeMemBytes: 64 * GB, cores: 32, override: 2 })).toBe(2);
  });

  it("override floors at 1 like everything else", () => {
    expect(concurrencyBudget({ freeMemBytes: 8 * GB, cores: 4, override: 0 })).toBe(1);
    expect(concurrencyBudget({ freeMemBytes: 8 * GB, cores: 4, override: -3 })).toBe(1);
  });

  it("defaults from the live host still produce a sane positive integer", () => {
    const budget = concurrencyBudget();
    expect(Number.isInteger(budget)).toBe(true);
    expect(budget).toBeGreaterThanOrEqual(1);
    expect(budget).toBeLessThanOrEqual(8);
  });
});

describe("config peerFanout", () => {
  const TRACKER = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("accepts peerFanout.maxConcurrent as a positive integer", () => {
    const d = writeTmpConfig({ ...TRACKER, peerFanout: { maxConcurrent: 4 } });
    expect(loadConfig(d).peerFanout?.maxConcurrent).toBe(4);
  });

  it("peerFanout is optional and absent by default", () => {
    const d = writeTmpConfig(TRACKER);
    expect(loadConfig(d).peerFanout).toBeUndefined();
  });

  it("rejects non-positive and non-integer maxConcurrent", () => {
    for (const bad of [0, -2, 2.5]) {
      const d = writeTmpConfig({ ...TRACKER, peerFanout: { maxConcurrent: bad } });
      expect(() => loadConfig(d)).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
  });
});
