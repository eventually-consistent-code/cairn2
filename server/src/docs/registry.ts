import { CairnError } from "../errors.js";
import type { CairnConfig } from "../config.js";
import { importErrorToCairn } from "../tracker/registry.js";
import type { DocsConnector } from "./types.js";

const CONNECTOR_PATHS: Record<string, string> = {
  confluence: "./adapters/confluence.js",
  docusaurus: "./adapters/docusaurus.js",
};

interface ConnectorModule {
  configSchema: {
    safeParse(v: unknown): {
      success: boolean;
      data?: unknown;
      error?: { issues: Array<{ message: string; path: Array<string | number> }> };
    };
  };
  make(c: never): DocsConnector;
}

export async function makeDocsConnector(cfg: CairnConfig): Promise<DocsConnector> {
  if (!cfg.docs) {
    throw new CairnError("CONFIG_MISSING", "no docs block in cairn.json",
      "add docs: { connector, config } — see templates/cairn.json.example");
  }
  const { connector, config } = cfg.docs;
  let mod: ConnectorModule;
  try {
    mod = (await import(CONNECTOR_PATHS[connector])) as ConnectorModule;
  } catch (e) {
    throw importErrorToCairn(connector, e);
  }
  const parsed = mod.configSchema.safeParse(config);
  if (!parsed.success) {
    throw new CairnError("CONFIG_INVALID",
      `${connector} docs config: ${parsed.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      `fix docs.config in cairn.json (see templates/cairn.json.example)`);
  }
  return mod.make(parsed.data as never);
}
