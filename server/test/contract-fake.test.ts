import { describe, it, expect } from "vitest";
import { trackerContract } from "./contract.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { CairnError } from "../src/errors.js";

trackerContract("fake", async () => new FakeTracker());

describe("FakeTracker error fidelity", () => {
  it("getIssue throws a typed CairnError with code NOT_FOUND for an unknown id", async () => {
    const t = new FakeTracker();
    await expect(t.getIssue("nope")).rejects.toThrow(CairnError);
    await t.getIssue("nope").catch((e) => {
      expect(e).toBeInstanceOf(CairnError);
      expect(e.code).toBe("NOT_FOUND");
    });
  });
});
