import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { make } from "../src/tracker/adapters/gitlab.js";

const project = process.env.CAIRN_TEST_GITLAB_PROJECT; // e.g. "youruser/cairn-sandbox"
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!project;

if (enabled) {
  trackerContract("gitlab (live)", async () =>
    make({ project: project!, baseUrl: "https://gitlab.com", tokenEnv: "GITLAB_TOKEN", extraLabels: [] }),
  );
} else {
  describe("gitlab live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1 and CAIRN_TEST_GITLAB_PROJECT to run", () => {});
  });
}
