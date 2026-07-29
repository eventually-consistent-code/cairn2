import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "./errors.js";
import { PROVIDERS } from "./peers/providers.js";
export const ConfigSchema = z.object({
    tracker: z.object({
        type: z.enum(["github", "gitlab", "jira", "asana", "azure-boards", "clickup", "linear", "local"]),
        config: z.record(z.unknown()),
    }),
    // Documentation connectors publish repo docs outward (Confluence first);
    // same two-level shape as tracker — deep validation lives in the adapter.
    docs: z
        .object({
        connector: z.enum(["confluence", "docusaurus"]),
        config: z.record(z.unknown()),
    })
        .optional(),
    agents: z
        .object({ model: z.enum(["auto", "inherit", "haiku", "sonnet", "opus"]) })
        .default({ model: "auto" }),
    memory: z
        .object({ tokenThreshold: z.number().int().positive() })
        .default({ tokenThreshold: 150000 }),
    user: z.object({
        handle: z.string().min(1),
        mode: z.enum(["vibe", "engineer"]).optional(),
    }).optional(),
    continuity: z
        .object({
        resume: z.enum(["prompt", "auto", "off"]).default("prompt"),
        checkpoint: z.boolean().default(true),
        wipCommits: z.boolean().default(false),
        recallIndex: z
            .object({
            enabled: z.boolean().default(true),
            maxCards: z.number().int().positive().default(20),
        })
            .default({}),
    })
        .default({}),
    leakGuard: z
        .object({
        enabled: z.boolean().default(true),
        allow: z.array(z.string()).default([]),
        extraPatterns: z.array(z.string()).default([]),
    })
        .default({}),
    // Per-provider peer CLI settings (Tier F2 #997) — absent provider or
    // absent field means enabled with defaults; unknown provider keys are
    // rejected by the enum-keyed record below.
    peers: z
        .record(z.enum(PROVIDERS), z.object({
        enabled: z.boolean().optional(),
        maxInputChars: z.number().int().positive().optional(),
    }))
        .optional(),
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
const SECRET_KEY_RE = /^(token|apiToken|api_key|apikey|password|secret|pat)$/i;
const SECRET_VALUE_RE = /^(ATATT|ghp_|github_pat_|glpat-|xoxb-|sk-)/;
function assertNoSecrets(patch, path = []) {
    if (patch === null || typeof patch !== "object") {
        if (typeof patch === "string" && SECRET_VALUE_RE.test(patch)) {
            throw new CairnError("CONFIG_INVALID", `value at ${path.join(".")} looks like a credential — secrets do not belong in cairn.json`, "put credentials in env vars (see each adapter's *Env config keys)");
        }
        return;
    }
    for (const [k, v] of Object.entries(patch)) {
        if (SECRET_KEY_RE.test(k)) {
            throw new CairnError("CONFIG_INVALID", `key '${[...path, k].join(".")}' — secrets do not belong in cairn.json`, "put credentials in env vars (see each adapter's *Env config keys)");
        }
        assertNoSecrets(v, [...path, k]);
    }
}
function deepMerge(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) {
            delete out[k];
        }
        else if (typeof v === "object" && !Array.isArray(v)
            && typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k], v);
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
export function writeConfigPatch(projectDir, patch) {
    assertNoSecrets(patch);
    const path = join(projectDir, "cairn.json");
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (e) {
        throw new CairnError("CONFIG_MISSING", `cannot read cairn.json: ${e}`, "create cairn.json — see templates/cairn.json.example");
    }
    const merged = deepMerge(raw, patch);
    const result = ConfigSchema.safeParse(merged);
    if (!result.success) {
        throw new CairnError("CONFIG_INVALID", result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
    return result.data;
}
