import { z } from "zod";
export declare function parseFrontmatter(text: string): {
    data: Record<string, string | string[]>;
    body: string;
};
export declare function serializeFrontmatter(data: Record<string, string | string[]>, body: string): string;
export declare const PlanFrontmatterSchema: z.ZodObject<{
    issues: z.ZodDefault<z.ZodArray<z.ZodString>>;
    depth: z.ZodOptional<z.ZodEnum<{
        quick: "quick";
        standard: "standard";
        deep: "deep";
    }>>;
}, z.core.$strip>;
export declare function parsePlanDoc(text: string): {
    frontmatter: z.infer<typeof PlanFrontmatterSchema>;
    body: string;
};
