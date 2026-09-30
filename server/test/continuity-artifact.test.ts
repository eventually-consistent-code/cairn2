import { describe, it, expect } from "vitest";
import { validateArtifacts, DegradedCheckpointError } from "../src/core/continuity.js";

const good = () => ({
  decisions: ["Threshold set to 0.2 after simulation over the recorded corpus"],
  constraints: ["No new runtime dependencies"],
  rejected: ["Local MoE digest — median read is 878 tokens, nothing to compress"],
  state: "Task 8 landed; boundary detectors verified against a real transcript.",
  filesTouched: ["server/src/context/boundary.ts"],
  nextSteps: ["Wire the artifact contract into continuity_checkpoint"],
  requirements: "Cut agent spend without degrading output quality.",
  skills: ["cairn:cairn-memory"],
});

describe("compaction artifact contract", () => {
  it("accepts a complete checkpoint", () => {
    expect(() => validateArtifacts(good())).not.toThrow();
  });

  it("refuses a checkpoint with no decisions", () => {
    expect(() => validateArtifacts({ ...good(), decisions: [] }))
      .toThrow(DegradedCheckpointError);
  });

  it("refuses a checkpoint with an empty state summary", () => {
    expect(() => validateArtifacts({ ...good(), state: "   " }))
      .toThrow(DegradedCheckpointError);
  });

  it("refuses a state summary too short to resume from", () => {
    expect(() => validateArtifacts({ ...good(), state: "ok" }))
      .toThrow(DegradedCheckpointError);
  });

  it("refuses a checkpoint that dropped the user's requirements", () => {
    expect(() => validateArtifacts({ ...good(), requirements: "" }))
      .toThrow(DegradedCheckpointError);
  });

  it("names every missing artifact at once, not just the first", () => {
    try {
      validateArtifacts({ ...good(), decisions: [], state: "", requirements: "" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DegradedCheckpointError);
      expect((e as DegradedCheckpointError).missing.sort())
        .toEqual(["decisions", "requirements", "state"]);
    }
  });

  it("allows empty rejected and skills — a session may genuinely have neither", () => {
    expect(() => validateArtifacts({ ...good(), rejected: [], skills: [] })).not.toThrow();
  });

  it("allows empty nextSteps on a checkpoint at the end of the work", () => {
    expect(() => validateArtifacts({ ...good(), nextSteps: [] })).not.toThrow();
  });
});
