import { describe, it } from "vitest";
import { docsConnectorContract } from "./docs-contract.js";
import { ConfluenceConnector } from "../src/docs/adapters/confluence.js";

const baseUrl = process.env.CAIRN_TEST_CONFLUENCE_BASE_URL;
const spaceKey = process.env.CAIRN_TEST_CONFLUENCE_SPACE_KEY;
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!baseUrl && !!spaceKey;

if (enabled) {
  // Contract pages upsert under a stable prefix, so re-runs reuse the same
  // pages instead of littering the space.
  docsConnectorContract("confluence (live)", () => new ConfluenceConnector({
    baseUrl: baseUrl!,
    spaceKey: spaceKey!,
    emailEnv: process.env.CAIRN_TEST_CONFLUENCE_EMAIL_ENV ?? "JIRA_EMAIL",
    tokenEnv: process.env.CAIRN_TEST_CONFLUENCE_TOKEN_ENV ?? "JIRA_API_TOKEN",
  }), { titlePrefix: "cairn-" });
} else {
  describe("confluence live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1, CAIRN_TEST_CONFLUENCE_BASE_URL, CAIRN_TEST_CONFLUENCE_SPACE_KEY (+ creds env) to run", () => {});
  });
}
