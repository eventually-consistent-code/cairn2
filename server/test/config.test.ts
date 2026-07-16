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

  it("memory.tokenThreshold defaults to 150000 when omitted", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    expect(loadConfig(d).memory.tokenThreshold).toBe(150000);
  });

  it("memory.tokenThreshold respects an explicit override", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      memory: { tokenThreshold: 50000 },
    }));
    expect(loadConfig(d).memory.tokenThreshold).toBe(50000);
  });

  it("user is optional and absent by default", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    expect(loadConfig(d).user).toBeUndefined();
  });

  it("user.handle round-trips when provided", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      user: { handle: "jsreed" },
    }));
    expect(loadConfig(d).user).toEqual({ handle: "jsreed" });
  });

  it("continuity defaults apply when omitted", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const cfg = loadConfig(d);
    expect(cfg.continuity).toEqual({
      resume: "prompt",
      checkpoint: true,
      wipCommits: false,
      recallIndex: { enabled: true, maxCards: 20 },
    });
  });

  it("continuity respects explicit overrides", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: {
        resume: "auto",
        checkpoint: false,
        wipCommits: true,
        recallIndex: { enabled: false, maxCards: 5 },
      },
    }));
    const cfg = loadConfig(d);
    expect(cfg.continuity).toEqual({
      resume: "auto",
      checkpoint: false,
      wipCommits: true,
      recallIndex: { enabled: false, maxCards: 5 },
    });
  });

  it("continuity.recallIndex defaults apply when continuity block is present but recallIndex omitted", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));
    const cfg = loadConfig(d);
    expect(cfg.continuity.resume).toBe("off");
    expect(cfg.continuity.checkpoint).toBe(true);
    expect(cfg.continuity.recallIndex).toEqual({ enabled: true, maxCards: 20 });
  });

  it("an existing fixture config without a continuity block still parses (backward compatible)", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "jira", config: { baseUrl: "https://x.atlassian.net", projectKey: "PROJ" } },
      agents: { model: "sonnet" },
      memory: { tokenThreshold: 90000 },
      user: { handle: "jsreed" },
    }));
    const cfg = loadConfig(d);
    expect(cfg.continuity.resume).toBe("prompt");
    expect(cfg.agents.model).toBe("sonnet");
  });
});
