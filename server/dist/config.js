import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "./errors.js";
export const ConfigSchema = z.object({
    tracker: z.object({
        type: z.enum(["github", "gitlab", "jira", "asana", "azure-boards", "clickup"]),
        config: z.record(z.unknown()),
    }),
    agents: z
        .object({ model: z.enum(["auto", "inherit", "haiku", "sonnet", "opus"]) })
        .default({ model: "auto" }),
});
export function loadConfig(projectDir) {
    let raw;
    try {
        raw = readFileSync(join(projectDir, "cairn.json"), "utf8");
    }
    catch {
        throw new CairnError("CONFIG_MISSING", `no cairn.json in ${projectDir}`, "create cairn.json — see templates/cairn.json.example");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        throw new CairnError("CONFIG_INVALID", `cairn.json is not valid JSON: ${e}`);
    }
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
        throw new CairnError("CONFIG_INVALID", result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return result.data;
}
