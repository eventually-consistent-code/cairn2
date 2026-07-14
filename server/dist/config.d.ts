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
}>;
export type CairnConfig = z.infer<typeof ConfigSchema>;
export declare function loadConfig(projectDir: string): CairnConfig;
