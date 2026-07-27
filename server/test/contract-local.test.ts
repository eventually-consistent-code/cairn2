import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackerContract } from "./contract.js";
import { configSchema, make } from "../src/tracker/adapters/local.js";

trackerContract("local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-local-"));
  return make(configSchema.parse({ prefix: "lt" }), dir);
});
