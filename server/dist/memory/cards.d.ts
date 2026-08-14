import { z } from "zod";
export declare const CardFrontmatterSchema: z.ZodObject<{
    type: z.ZodEnum<{
        decision: "decision";
        note: "note";
        constraint: "constraint";
        gotcha: "gotcha";
        reference: "reference";
    }>;
    scopePhase: z.ZodOptional<z.ZodString>;
    scopeIssue: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
    }>>;
    provenanceFiles: z.ZodDefault<z.ZodArray<z.ZodString>>;
    provenanceCommits: z.ZodDefault<z.ZodArray<z.ZodString>>;
    created: z.ZodString;
}, z.core.$strip>;
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
