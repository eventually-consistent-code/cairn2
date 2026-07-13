import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { JiraTracker } from "../src/tracker/adapters/jira.js";

const baseUrl = process.env.CAIRN_TEST_JIRA_BASE_URL;
const projectKey = process.env.CAIRN_TEST_JIRA_PROJECT_KEY;
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!baseUrl && !!projectKey;

if (enabled) {
  trackerContract("jira (live)", async () => new JiraTracker({
    baseUrl: baseUrl!,
    projectKey: projectKey!,
    issueType: "Task",
    emailEnv: "JIRA_EMAIL",
    tokenEnv: "JIRA_API_TOKEN",
    transitions: { in_progress: "In Progress", closed: "Done" },
  }));
} else {
  describe("jira live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1, CAIRN_TEST_JIRA_BASE_URL, CAIRN_TEST_JIRA_PROJECT_KEY, JIRA_EMAIL, JIRA_API_TOKEN to run", () => {});
  });
}
