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
}, "strip", z.ZodTypeAny, {
    tracker: {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup";
        config: Record<string, unknown>;
    };
    agents: {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    };
}, {
    tracker: {
        type: "github" | "gitlab" | "jira" | "asana" | "azure-boards" | "clickup";
        config: Record<string, unknown>;
    };
    agents?: {
        model: "auto" | "inherit" | "haiku" | "sonnet" | "opus";
    } | undefined;
}>;
export type CairnConfig = z.infer<typeof ConfigSchema>;
export declare function loadConfig(projectDir: string): CairnConfig;
