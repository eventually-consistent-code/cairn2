import { z } from "zod";
export declare const ConfigSchema: z.ZodObject<{
    tracker: z.ZodObject<{
        type: z.ZodEnum<["github", "gitlab", "jira", "asana", "azure-boards", "clickup", "linear", "local"]>;
        config: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup" | "linear" | "local";
        config: Record<string, unknown>;
    }, {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup" | "linear" | "local";
        config: Record<string, unknown>;
    }>;
    docs: z.ZodOptional<z.ZodObject<{
        connector: z.ZodEnum<["confluence", "docusaurus"]>;
        config: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        config: Record<string, unknown>;
        connector: "confluence" | "docusaurus";
    }, {
        config: Record<string, unknown>;
        connector: "confluence" | "docusaurus";
    }>>;
    agents: z.ZodDefault<z.ZodObject<{
        model: z.ZodEnum<["auto", "inherit", "haiku", "sonnet", "opus"]>;
    }, "strip", z.ZodTypeAny, {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    }, {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    }>>;
    memory: z.ZodDefault<z.ZodObject<{
        tokenThreshold: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        tokenThreshold: number;
    }, {
        tokenThreshold: number;
    }>>;
    user: z.ZodOptional<z.ZodObject<{
        handle: z.ZodString;
        mode: z.ZodOptional<z.ZodEnum<["vibe", "engineer"]>>;
    }, "strip", z.ZodTypeAny, {
        handle: string;
        mode?: "vibe" | "engineer" | undefined;
    }, {
        handle: string;
        mode?: "vibe" | "engineer" | undefined;
    }>>;
    continuity: z.ZodDefault<z.ZodObject<{
        resume: z.ZodDefault<z.ZodEnum<["prompt", "auto", "off"]>>;
        checkpoint: z.ZodDefault<z.ZodBoolean>;
        wipCommits: z.ZodDefault<z.ZodBoolean>;
        recallIndex: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            maxCards: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            maxCards: number;
        }, {
            enabled?: boolean | undefined;
            maxCards?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        resume: "auto" | "prompt" | "off";
        checkpoint: boolean;
        wipCommits: boolean;
        recallIndex: {
            enabled: boolean;
            maxCards: number;
        };
    }, {
        resume?: "auto" | "prompt" | "off" | undefined;
        checkpoint?: boolean | undefined;
        wipCommits?: boolean | undefined;
        recallIndex?: {
            enabled?: boolean | undefined;
            maxCards?: number | undefined;
        } | undefined;
    }>>;
    leakGuard: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        allow: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        extraPatterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        allow: string[];
        extraPatterns: string[];
    }, {
        enabled?: boolean | undefined;
        allow?: string[] | undefined;
        extraPatterns?: string[] | undefined;
    }>>;
    peers: z.ZodOptional<z.ZodRecord<z.ZodEnum<["codex", "opencode", "antigravity", "grok"]>, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        maxInputChars: z.ZodOptional<z.ZodNumber>;
        execCapable: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled?: boolean | undefined;
        maxInputChars?: number | undefined;
        execCapable?: boolean | undefined;
    }, {
        enabled?: boolean | undefined;
        maxInputChars?: number | undefined;
        execCapable?: boolean | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    tracker: {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup" | "linear" | "local";
        config: Record<string, unknown>;
    };
    agents: {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    };
    memory: {
        tokenThreshold: number;
    };
    continuity: {
        resume: "auto" | "prompt" | "off";
        checkpoint: boolean;
        wipCommits: boolean;
        recallIndex: {
            enabled: boolean;
            maxCards: number;
        };
    };
    leakGuard: {
        enabled: boolean;
        allow: string[];
        extraPatterns: string[];
    };
    docs?: {
        config: Record<string, unknown>;
        connector: "confluence" | "docusaurus";
    } | undefined;
    user?: {
        handle: string;
        mode?: "vibe" | "engineer" | undefined;
    } | undefined;
    peers?: Partial<Record<"codex" | "opencode" | "antigravity" | "grok", {
        enabled?: boolean | undefined;
        maxInputChars?: number | undefined;
        execCapable?: boolean | undefined;
    }>> | undefined;
}, {
    tracker: {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup" | "linear" | "local";
        config: Record<string, unknown>;
    };
    docs?: {
        config: Record<string, unknown>;
        connector: "confluence" | "docusaurus";
    } | undefined;
    agents?: {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    } | undefined;
    memory?: {
        tokenThreshold: number;
    } | undefined;
    user?: {
        handle: string;
        mode?: "vibe" | "engineer" | undefined;
    } | undefined;
    continuity?: {
        resume?: "auto" | "prompt" | "off" | undefined;
        checkpoint?: boolean | undefined;
        wipCommits?: boolean | undefined;
        recallIndex?: {
            enabled?: boolean | undefined;
            maxCards?: number | undefined;
        } | undefined;
    } | undefined;
    leakGuard?: {
        enabled?: boolean | undefined;
        allow?: string[] | undefined;
        extraPatterns?: string[] | undefined;
    } | undefined;
    peers?: Partial<Record<"codex" | "opencode" | "antigravity" | "grok", {
        enabled?: boolean | undefined;
        maxInputChars?: number | undefined;
        execCapable?: boolean | undefined;
    }>> | undefined;
}>;
export type CairnConfig = z.infer<typeof ConfigSchema>;
export declare function loadConfig(projectDir: string): CairnConfig;
export declare function writeConfigPatch(projectDir: string, patch: Record<string, unknown>): CairnConfig;
