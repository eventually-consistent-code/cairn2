import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { CairnError } from "../src/errors.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-"));

describe("loadConfig", () => {
  it("loads a valid github config with default agents.model=auto", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const cfg = loadConfig(d);
    expect(cfg.tracker.type).toBe("github");
    expect(cfg.agents.model).toBe("auto");
  });

  it("throws CONFIG_MISSING when cairn.json absent", () => {
    expect(() => loadConfig(dir())).toThrowError(
      expect.objectContaining({ code: "CONFIG_MISSING" }));
  });

  it("throws CONFIG_INVALID on bad tracker type", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "trello", config: {} } }));
    expect(() => loadConfig(d)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
