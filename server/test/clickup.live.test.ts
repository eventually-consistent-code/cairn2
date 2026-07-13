import { describe, it } from "vitest";
import { trackerContract } from "./contract.js";
import { ClickUpTracker } from "../src/tracker/adapters/clickup.js";

const defaultListId = process.env.CAIRN_TEST_CLICKUP_DEFAULT_LIST;
const spaceId = process.env.CAIRN_TEST_CLICKUP_SPACE;
const folderId = process.env.CAIRN_TEST_CLICKUP_FOLDER;
const enabled = process.env.CAIRN_LIVE_TESTS === "1" && !!defaultListId && !!(spaceId || folderId);

if (enabled) {
  trackerContract("clickup (live)", async () => new ClickUpTracker({
    defaultListId: defaultListId!,
    folderId,
    spaceId: folderId ? undefined : spaceId,
    tokenEnv: "CLICKUP_TOKEN",
    statuses: { open: "to do", in_progress: "in progress", closed: "complete" },
  }));
} else {
  describe("clickup live contract", () => {
    it.skip("set CAIRN_LIVE_TESTS=1, CAIRN_TEST_CLICKUP_DEFAULT_LIST, and CAIRN_TEST_CLICKUP_SPACE or _FOLDER, plus CLICKUP_TOKEN, to run", () => {});
  });
}
