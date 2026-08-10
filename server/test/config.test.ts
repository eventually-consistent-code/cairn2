import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeConfigPatch } from "../src/config.js";
import { CairnError } from "../src/errors.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-"));

// Makes a temp project dir with a cairn.json seeded from obj — mirrors the
// dir() + writeFileSync idiom above, just bundled for the writeConfigPatch tests.
function writeTmpConfig(obj: Record<string, unknown>): string {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify(obj));
  return d;
}

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

  it("accepts user.mode engineer and vibe, rejects others", () => {
    const d = dir();
    const base = { tracker: { type: "github", config: { repo: "o/r" } }, user: { handle: "jr", mode: "engineer" } };
    writeFileSync(join(d, "cairn.json"), JSON.stringify(base));
    expect(loadConfig(d).user?.mode).toBe("engineer");
    base.user.mode = "vibe";
    writeFileSync(join(d, "cairn.json"), JSON.stringify(base));
    expect(loadConfig(d).user?.mode).toBe("vibe");
    base.user.mode = "yolo" as never;
    writeFileSync(join(d, "cairn.json"), JSON.stringify(base));
    expect(() => loadConfig(d)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("user.mode is optional", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      user: { handle: "jr" },
    }));
    expect(loadConfig(d).user?.mode).toBeUndefined();
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

describe("writeConfigPatch", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("merges nested keys and returns the validated result", () => {
    const dir = writeTmpConfig(base);
    const out = writeConfigPatch(dir, { continuity: { resume: "auto" } });
    expect(out.continuity.resume).toBe("auto");
    const raw = JSON.parse(readFileSync(join(dir, "cairn.json"), "utf8"));
    expect(raw.continuity.resume).toBe("auto");
    expect(raw.tracker.config.repo).toBe("o/r"); // untouched siblings survive
  });

  it("null deletes a key", () => {
    const dir = writeTmpConfig({ ...base, user: { handle: "john" } });
    writeConfigPatch(dir, { user: null });
    const raw = JSON.parse(readFileSync(join(dir, "cairn.json"), "utf8"));
    expect(raw.user).toBeUndefined();
  });

  it("invalid merged config leaves the file untouched", () => {
    const dir = writeTmpConfig(base);
    const before = readFileSync(join(dir, "cairn.json"), "utf8");
    expect(() => writeConfigPatch(dir, { continuity: { resume: "sometimes" } }))
      .toThrowError(/CONFIG|resume/i);
    expect(readFileSync(join(dir, "cairn.json"), "utf8")).toBe(before);
  });

  it("refuses secret-looking keys and values", () => {
    const dir = writeTmpConfig(base);
    expect(() => writeConfigPatch(dir, { tracker: { config: { token: "x" } } }))
      .toThrowError(/secrets do not belong/);
    expect(() => writeConfigPatch(dir, { user: { handle: "ATATT3xFfGF0abc" } }))
      .toThrowError(/secrets do not belong/);
  });

  it("leakGuard defaults land via loadConfig", () => {
    const dir = writeTmpConfig(base);
    const cfg = loadConfig(dir);
    expect(cfg.leakGuard).toEqual({ enabled: true, allow: [], extraPatterns: [] });
  });
});

describe("peers config", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("peers is absent by default", () => {
    const dir = writeTmpConfig(base);
    expect(loadConfig(dir).peers).toBeUndefined();
  });

  it("accepts known provider keys with partial fields and applies defaults on read", () => {
    const dir = writeTmpConfig({
      ...base,
      peers: { codex: { enabled: false }, antigravity: { maxInputChars: 900000 } },
    });
    const cfg = loadConfig(dir);
    expect(cfg.peers).toEqual({
      codex: { enabled: false },
      antigravity: { maxInputChars: 900000 },
    });
  });

  it("rejects an unknown provider key", () => {
    const dir = writeTmpConfig({ ...base, peers: { totallyBogus: { enabled: true } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  // gemini left the roster when antigravity replaced it — a leftover
  // peers.gemini block must fail loud (CONFIG_INVALID) so the user removes
  // it, never silently load.
  it("rejects the retired gemini provider key", () => {
    const dir = writeTmpConfig({ ...base, peers: { gemini: { enabled: true } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("config_set-style patching via writeConfigPatch validates the peers block", () => {
    const dir = writeTmpConfig(base);
    const out = writeConfigPatch(dir, { peers: { grok: { enabled: true, maxInputChars: 5000 } } });
    expect(out.peers).toEqual({ grok: { enabled: true, maxInputChars: 5000 } });
    expect(() => writeConfigPatch(dir, { peers: { notAProvider: {} } }))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
