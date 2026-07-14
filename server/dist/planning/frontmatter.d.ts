import { z } from "zod";
export declare function parseFrontmatter(text: string): {
    data: Record<string, string | string[]>;
    body: string;
};
export declare function serializeFrontmatter(data: Record<string, string | string[]>, body: string): string;
export declare const PlanFrontmatterSchema: z.ZodObject<{
    issues: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    depth: z.ZodOptional<z.ZodEnum<["quick", "standard", "deep"]>>;
}, "strip", z.ZodTypeAny, {
    issues: string[];
    depth?: "quick" | "standard" | "deep" | undefined;
}, {
    issues?: string[] | undefined;
    depth?: "quick" | "standard" | "deep" | undefined;
}>;
export declare function parsePlanDoc(text: string): {
    frontmatter: z.infer<typeof PlanFrontmatterSchema>;
    body: string;
};
