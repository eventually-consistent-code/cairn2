import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { emitOutlook, outlookMirrorPath } from "../src/core/outlook.js";

// The four fixed URIs the resources surface exposes (#99). listResources
// must enumerate exactly these -- a fifth (or a missing one) is a drift bug.
const EXPECTED_URIS = [
  "cairn://outlook/snapshot",
  "cairn://plans/active-phase/context",
  "cairn://plans/active-phase/plan",
  "cairn://plans/roadmap",
];

const CAIRN_JSON = JSON.stringify({
  tracker: { type: "github", config: { repo: "o/r" } },
});

const ROADMAP = "# Roadmap\n\nPhase 1 then phase 2. That's the plan...\n";
const PLAN_1 = "# Plan 1\n\nShip the first thing.\n";
const CONTEXT_1 = "# Context 1\n\nWhy the first thing matters.\n";
const PLAN_2 = "# Plan 2\n\nShip the second thing.\n";

async function connect(projectDir: string): Promise<Client> {
  const server = buildServer({
    projectDir,
    tracker: new FakeTracker(),
    fetchLatestVersion: async () => "9.9.9",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("plan artifacts as MCP resources (#99)", () => {
  let client: Client;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-resources-"));
    writeFileSync(join(projectDir, "cairn.json"), CAIRN_JSON);

    // Two phases: 1 is verified (has VERIFICATION.md), 2 is the lowest
    // unverified. Phase 2 deliberately has no CONTEXT.md so the per-file
    // placeholder path gets exercised alongside the happy reads.
    const plans = join(projectDir, ".cairn", "plans");
    const p1 = join(plans, "phases", "01-first");
    const p2 = join(plans, "phases", "02-second");
    mkdirSync(p1, { recursive: true });
    mkdirSync(p2, { recursive: true });
    writeFileSync(join(plans, "roadmap.md"), ROADMAP);
    writeFileSync(join(p1, "PLAN.md"), PLAN_1);
    writeFileSync(join(p1, "CONTEXT.md"), CONTEXT_1);
    writeFileSync(join(p1, "VERIFICATION.md"), "# Verified\n");
    writeFileSync(join(p2, "PLAN.md"), PLAN_2);

    client = await connect(projectDir);
  });

  afterAll(() => {
    rmSync(outlookMirrorPath(projectDir), { force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const read = async (uri: string) => {
    const res = await client.readResource({ uri });
    return res.contents[0] as { uri: string; text: string; mimeType?: string };
  };

  it("lists exactly the four plan-artifact resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(EXPECTED_URIS);
  });

  it("roadmap read round-trips the file content", async () => {
    const got = await read("cairn://plans/roadmap");
    expect(got.text).toBe(ROADMAP);
    expect(got.mimeType).toBe("text/markdown");
  });

  it("active phase falls back to the lowest unverified phase when unset", async () => {
    // No active context -- phase 1 is verified, so phase 2's PLAN.md serves.
    const got = await read("cairn://plans/active-phase/plan");
    expect(got.text).toBe(PLAN_2);
  });

  it("a scaffolded phase missing one artifact reads as a placeholder", async () => {
    // Phase 2 has no CONTEXT.md -- placeholder text, never an error.
    const got = await read("cairn://plans/active-phase/context");
    expect(got.text).toContain("no CONTEXT.md for phase 2");
  });

  it("an explicit active context pins the served phase", async () => {
    const stateDir = join(projectDir, ".cairn", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "active-context.json"),
      JSON.stringify({ phase: 1 }),
    );
    const plan = await read("cairn://plans/active-phase/plan");
    const context = await read("cairn://plans/active-phase/context");
    expect(plan.text).toBe(PLAN_1);
    expect(context.text).toBe(CONTEXT_1);
  });

  it("outlook snapshot reads back the mirror JSON", async () => {
    emitOutlook(projectDir);
    const got = await read("cairn://outlook/snapshot");
    expect(got.mimeType).toBe("application/json");
    const snap = JSON.parse(got.text);
    expect(snap.version).toBe(1);
    expect(snap.path).toBe(projectDir);
    expect(snap.phases.map((p: { number: number }) => p.number)).toEqual([
      1, 2,
    ]);
  });
});

describe("resources on a bare project (nothing scaffolded)", () => {
  let client: Client;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-resources-bare-"));
    writeFileSync(join(projectDir, "cairn.json"), CAIRN_JSON);
    client = await connect(projectDir);
  });

  afterAll(() => {
    rmSync(outlookMirrorPath(projectDir), { force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const read = async (uri: string) => {
    const res = await client.readResource({ uri });
    return (res.contents[0] as { text: string }).text;
  };

  it("missing roadmap reads as a placeholder, not an error", async () => {
    expect(await read("cairn://plans/roadmap")).toContain("no roadmap yet");
  });

  it("no phases reads as a short 'no phases scaffolded' text", async () => {
    expect(await read("cairn://plans/active-phase/plan")).toContain(
      "no phases scaffolded",
    );
    expect(await read("cairn://plans/active-phase/context")).toContain(
      "no phases scaffolded",
    );
  });

  it("absent outlook snapshot reads as 'no snapshot yet'", async () => {
    expect(await read("cairn://outlook/snapshot")).toContain(
      "no snapshot yet",
    );
  });
});
