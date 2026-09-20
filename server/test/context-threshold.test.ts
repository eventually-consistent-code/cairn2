import { describe, it, expect } from "vitest";
import { thresholdDrift } from "../src/context/threshold.js";

describe("autocompact threshold drift", () => {
  it("is unset when the project has expressed no preference", () => {
    expect(thresholdDrift(null, undefined))
      .toEqual({ status: "unset", desired: null, live: null });
  });

  it("matches when the live env equals the desired value", () => {
    expect(thresholdDrift(0.2, "0.2"))
      .toEqual({ status: "match", desired: 0.2, live: 0.2 });
  });

  it("reports drift when the env is absent but a value is desired", () => {
    expect(thresholdDrift(0.2, undefined))
      .toEqual({ status: "drift", desired: 0.2, live: null });
  });

  it("reports drift when the env disagrees with the desired value", () => {
    expect(thresholdDrift(0.2, "0.85"))
      .toEqual({ status: "drift", desired: 0.2, live: 0.85 });
  });

  it("calls an unparseable env value invalid rather than guessing", () => {
    expect(thresholdDrift(0.2, "aggressive"))
      .toEqual({ status: "invalid", desired: 0.2, live: null });
  });

  it("tolerates float noise — 0.2 and 0.200 are the same setting", () => {
    expect(thresholdDrift(0.2, "0.200").status).toBe("match");
  });
});
