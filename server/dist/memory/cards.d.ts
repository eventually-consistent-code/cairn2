import { z } from "zod";
export declare const CardFrontmatterSchema: z.ZodObject<{
    type: z.ZodEnum<{
        decision: "decision";
        constraint: "constraint";
        gotcha: "gotcha";
        reference: "reference";
        note: "note";
    }>;
    scopePhase: z.ZodOptional<z.ZodString>;
    scopeIssue: z.ZodOptional<z.ZodString>;
    scopeRole: z.ZodOptional<z.ZodString>;
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
    scopeRole?: string;
    confidence?: "high" | "medium" | "low";
    provenance?: Array<{
        file: string;
        commit: string;
    }>;
    provenanceFiles?: string[];
    provenanceCommits?: string[];
}): Card;
export declare function readCard(projectDir: string, id: string): Card;
export interface CardPatch {
    confidence?: "high" | "medium" | "low";
    scopeRole?: string;
    provenanceFiles?: string[];
    provenanceCommits?: string[];
}
export declare function updateCard(projectDir: string, id: string, patch: CardPatch): Card;
/**
 * Retires a card by deleting its file (#172). Card bodies are immutable, so
 * retirement is deletion -- never an edit in place, and never a body rewritten
 * to say "archived". The archive card that replaces a retired batch is a new
 * card written before any of this runs; see memory/compaction.ts.
 *
 * Returns false when the card was already gone, so retrying a half-finished
 * compaction is a no-op rather than an error.
 *
 * :param projectDir: repository root
 * :param id: card id, validated before it is joined onto a path
 * :returns: true when a file was removed
 */
export declare function deleteCard(projectDir: string, id: string): boolean;
export declare function updateCardConfidence(projectDir: string, id: string, confidence: "high" | "medium" | "low"): Card;
export declare function listCards(projectDir: string, filter?: {
    scopePhase?: number;
    scopeIssue?: string;
    scopeRole?: string;
}): Card[];
