import { z } from "zod";
import { CairnError } from "../errors.js";
import type { CairnConfig } from "../config.js";
import type { Tracker } from "./types.js";
import { GitHubTracker } from "./adapters/github.js";

const GitHubCfg = z.object({ repo: z.string().regex(/^[^/]+\/[^/]+$/) });

export function makeTracker(cfg: CairnConfig): Tracker {
  const { type, config } = cfg.tracker;
  switch (type) {
    case "github": {
      const parsed = GitHubCfg.safeParse(config);
      if (!parsed.success) {
        throw new CairnError("CONFIG_INVALID",
          `github tracker config: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          'set tracker.config.repo to "owner/name" in cairn.json');
      }
      return new GitHubTracker(parsed.data);
    }
    default:
      throw new CairnError("CONFIG_INVALID",
        `tracker type '${type}' is not yet implemented (P1b)`,
        "use github for now, or wait for the P1b adapter plan");
  }
}
