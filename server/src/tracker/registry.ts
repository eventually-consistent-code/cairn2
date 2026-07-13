import { CairnError } from "../errors.js";
import type { CairnConfig } from "../config.js";
import type { Tracker } from "./types.js";

const ADAPTER_PATHS: Record<CairnConfig["tracker"]["type"], string> = {
  github: "./adapters/github.js",
  gitlab: "./adapters/gitlab.js",
  jira: "./adapters/jira.js",
  asana: "./adapters/asana.js",
  "azure-boards": "./adapters/azure-boards.js",
  clickup: "./adapters/clickup.js",
};

interface AdapterModule {
  configSchema: {
    safeParse(v: unknown): {
      success: boolean;
      data?: unknown;
      error?: { issues: Array<{ message: string; path: Array<string | number> }> };
    };
  };
  make(c: never): Tracker;
}

export async function makeTracker(cfg: CairnConfig): Promise<Tracker> {
  const { type, config } = cfg.tracker;
  let mod: AdapterModule;
  try {
    mod = (await import(ADAPTER_PATHS[type])) as AdapterModule;
  } catch {
    throw new CairnError("CONFIG_INVALID", `tracker type '${type}' is not yet implemented`,
      "check cairn.json tracker.type, or update cairn");
  }
  const parsed = mod.configSchema.safeParse(config);
  if (!parsed.success) {
    throw new CairnError("CONFIG_INVALID",
      `${type} tracker config: ${parsed.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      `fix tracker.config in cairn.json (see templates/cairn.json.example)`);
  }
  return mod.make(parsed.data as never);
}
