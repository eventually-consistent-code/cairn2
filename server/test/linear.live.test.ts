import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { LinearTracker } from "../src/tracker/adapters/linear.js";

const teamId = process.env.CAIRN_TEST_LINEAR_TEAM; // team UUID in a sandbox workspace
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!teamId && !!process.env.LINEAR_API_KEY;

if (enabled) {
  trackerContract("linear (live)", async () =>
    new LinearTracker({ teamId: teamId!, apiKeyEnv: "LINEAR_API_KEY" }));
} else {
  describe("linear live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1, LINEAR_API_KEY and CAIRN_TEST_LINEAR_TEAM to run", () => {});
  });
}
