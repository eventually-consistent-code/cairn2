import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { AzureBoardsTracker } from "../src/tracker/adapters/azure-boards.js";

const orgUrl = process.env.CAIRN_TEST_AZURE_ORG_URL; // e.g. "https://dev.azure.com/yourorg"
const project = process.env.CAIRN_TEST_AZURE_PROJECT;
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!orgUrl && !!project;

if (enabled) {
  trackerContract("azure-boards (live)", async () => new AzureBoardsTracker({
    orgUrl: orgUrl!,
    project: project!,
    workItemType: "Issue",
    patEnv: "AZURE_DEVOPS_PAT",
    apiVersion: "7.0",
    states: { in_progress: "Doing", closed: "Done", open: "To Do" },
  }));
} else {
  describe("azure-boards live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1, CAIRN_TEST_AZURE_ORG_URL, CAIRN_TEST_AZURE_PROJECT to run", () => {});
  });
}
