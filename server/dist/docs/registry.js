import { CairnError } from "../errors.js";
import { importErrorToCairn } from "../tracker/registry.js";
const CONNECTOR_PATHS = {
    confluence: "./adapters/confluence.js",
    docusaurus: "./adapters/docusaurus.js",
};
export async function makeDocsConnector(cfg) {
    if (!cfg.docs) {
        throw new CairnError("CONFIG_MISSING", "no docs block in cairn.json", "add docs: { connector, config } — see templates/cairn.json.example");
    }
    const { connector, config } = cfg.docs;
    let mod;
    try {
        mod = (await import(CONNECTOR_PATHS[connector]));
    }
    catch (e) {
        throw importErrorToCairn(connector, e);
    }
    const parsed = mod.configSchema.safeParse(config);
    if (!parsed.success) {
        throw new CairnError("CONFIG_INVALID", `${connector} docs config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, `fix docs.config in cairn.json (see templates/cairn.json.example)`);
    }
    return mod.make(parsed.data);
}
