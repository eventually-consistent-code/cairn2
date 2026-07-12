import { describe, it, expect } from "vitest";
import { CairnError } from "../src/errors.js";

describe("CairnError", () => {
  it("carries code, message, nextAction", () => {
    const e = new CairnError("AUTH_MISSING", "no GITHUB_TOKEN", "export GITHUB_TOKEN or run gh auth login");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("AUTH_MISSING");
    expect(e.nextAction).toContain("gh auth login");
  });
});
