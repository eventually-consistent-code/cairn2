import { z } from "zod";
export declare const CardFrontmatterSchema: z.ZodEffects<z.ZodObject<{
    type: z.ZodEnum<["decision", "constraint", "gotcha", "reference", "note"]>;
    scopePhase: z.ZodOptional<z.ZodString>;
    scopeIssue: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodEnum<["high", "medium", "low"]>>;
    provenanceFiles: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    provenanceCommits: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    created: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "decision" | "note" | "constraint" | "gotcha" | "reference";
    created: string;
    provenanceFiles: string[];
    provenanceCommits: string[];
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
    confidence?: "high" | "medium" | "low" | undefined;
}, {
    type: "decision" | "note" | "constraint" | "gotcha" | "reference";
    created: string;
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
    confidence?: "high" | "medium" | "low" | undefined;
    provenanceFiles?: string[] | undefined;
    provenanceCommits?: string[] | undefined;
}>, {
    type: "decision" | "note" | "constraint" | "gotcha" | "reference";
    created: string;
    provenanceFiles: string[];
    provenanceCommits: string[];
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
    confidence?: "high" | "medium" | "low" | undefined;
}, {
    type: "decision" | "note" | "constraint" | "gotcha" | "reference";
    created: string;
    scopePhase?: string | undefined;
    scopeIssue?: string | undefined;
    confidence?: "high" | "medium" | "low" | undefined;
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
    type: "decision" | "constraint" | "gotcha" | "reference" | "note";
    body: string;
    scopePhase?: number;
    scopeIssue?: string;
    confidence?: "high" | "medium" | "low";
    provenance?: Array<{
        file: string;
        commit: string;
    }>;
}): Card;
export declare function readCard(projectDir: string, id: string): Card;
export declare function updateCardConfidence(projectDir: string, id: string, confidence: "high" | "medium" | "low"): Card;
export declare function listCards(projectDir: string, filter?: {
    scopePhase?: number;
    scopeIssue?: string;
}): Card[];
