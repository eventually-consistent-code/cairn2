export interface PlanFinding {
    /**
     * contract-drift / unanchored-threshold: PLAN.md text findings.
     * missing-approaches (phase 23): a planned, non-quick phase whose
     * CONTEXT.md lacks the "Approaches considered" block — two-plus
     * candidates and a chosen line — the divergent-design step the plan
     * verb owes before PLAN.md exists.
     */
    type: "contract-drift" | "unanchored-threshold" | "missing-approaches";
    plan: string;
    line: number;
    detail: string;
    counterpart?: {
        plan: string;
        line: number;
    };
}
export declare const APPROACHES_HEADING: RegExp;
export declare const APPROACHES_MIN_CANDIDATES = 2;
/**
 * Judges a CONTEXT.md's approaches block. Null when it satisfies the
 * shape; otherwise the line to anchor the finding on and what's missing.
 *
 * :param lines: CONTEXT.md split into lines
 * :returns: null, or { line, detail }
 */
export declare function judgeApproaches(lines: string[]): {
    line: number;
    detail: string;
} | null;
export declare function planCheck(projectDir: string, phase?: number): {
    findings: PlanFinding[];
    scanned: number;
};
