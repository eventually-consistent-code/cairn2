import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { GitHubTracker } from "../src/tracker/adapters/github.js";

const repo = process.env.CAIRN_TEST_GITHUB_REPO; // e.g. "you/cairn-sandbox"
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!repo;

if (enabled) {
  trackerContract("github (live)", async () => new GitHubTracker({ repo: repo! }));
} else {
  describe("github live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1 and CAIRN_TEST_GITHUB_REPO to run", () => {});
  });
}
