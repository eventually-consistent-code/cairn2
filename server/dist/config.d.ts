import { z } from "zod";
export declare const ConfigSchema: z.ZodObject<{
    tracker: z.ZodObject<{
        type: z.ZodEnum<["github", "gitlab", "jira", "asana", "azure-boards", "clickup"]>;
        config: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup";
        config: Record<string, unknown>;
    }, {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup";
        config: Record<string, unknown>;
    }>;
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
    }, "strip", z.ZodTypeAny, {
        handle: string;
    }, {
        handle: string;
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
}, "strip", z.ZodTypeAny, {
    tracker: {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup";
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
    user?: {
        handle: string;
    } | undefined;
}, {
    tracker: {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup";
        config: Record<string, unknown>;
    };
    agents?: {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    } | undefined;
    memory?: {
        tokenThreshold: number;
    } | undefined;
    user?: {
        handle: string;
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
}>;
export type CairnConfig = z.infer<typeof ConfigSchema>;
export declare function loadConfig(projectDir: string): CairnConfig;
