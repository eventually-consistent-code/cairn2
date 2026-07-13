import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { AsanaTracker } from "../src/tracker/adapters/asana.js";

const projectGid = process.env.CAIRN_TEST_ASANA_PROJECT_GID; // e.g. "1209..."
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!projectGid;

if (enabled) {
  trackerContract("asana (live)", async () =>
    new AsanaTracker({ projectGid: projectGid!, tokenEnv: "ASANA_TOKEN" }));
} else {
  describe("asana live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1 and CAIRN_TEST_ASANA_PROJECT_GID to run", () => {});
  });
}
