import { z } from "zod";
export declare const CardFrontmatterSchema: z.ZodEffects<z.ZodObject<{
    type: z.ZodEnum<["decision", "constraint", "gotcha", "reference"]>;
    scopePhase: z.ZodOptional<z.ZodString>;
    scopeIssue: z.ZodOptional<z.ZodString>;
    provenanceFiles: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    provenanceCommits: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    created: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "decision" | "constraint" | "gotcha" | "reference";
    created: string;
    provenanceFiles: string[];
    provenanceCommits: string[];
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
}, {
    type: "decision" | "constraint" | "gotcha" | "reference";
    created: string;
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
    provenanceFiles?: string[] | undefined;
    provenanceCommits?: string[] | undefined;
}>, {
    type: "decision" | "constraint" | "gotcha" | "reference";
    created: string;
    provenanceFiles: string[];
    provenanceCommits: string[];
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
}, {
    type: "decision" | "constraint" | "gotcha" | "reference";
    created: string;
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
    provenanceFiles?: string[] | undefined;
    provenanceCommits?: string[] | undefined;
}>;
export interface Card {
    id: string;
    frontmatter: z.infer<typeof CardFrontmatterSchema>;
    body: string;
}
export declare const cardsDir: (projectDir: string) => string;
export declare function createCard(projectDir: string, input: {
    type: "decision" | "constraint" | "gotcha" | "reference";
    body: string;
    scopePhase?: number;
    scopeIssue?: string;
    provenance?: Array<{
        file: string;
        commit: string;
    }>;
}): Card;
export declare function readCard(projectDir: string, id: string): Card;
export declare function listCards(projectDir: string, filter?: {
    scopePhase?: number;
    scopeIssue?: string;
}): Card[];
