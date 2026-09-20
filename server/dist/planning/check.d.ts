export interface PlanFinding {
    /**
     * contract-drift / unanchored-threshold: PLAN.md text findings.
     * missing-approaches (phase 23): a planned, non-quick phase whose
     * CONTEXT.md lacks the "Approaches considered" block — two-plus
     * candidates and a chosen line — the divergent-design step the plan
     * verb owes before PLAN.md exists.
     * missing-verify (phase 24.5): a task line in a planned, non-quick,
     * unverified PLAN.md that never says how it will be proved. Criteria
     * written after the fact are chosen to fit what happened.
     */
    type: "contract-drift" | "unanchored-threshold" | "missing-approaches" | "missing-verify";
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
 * Task lines in a plan that never declare how they will be proved.
 *
 * The declaration may appear anywhere in the task's own paragraph, not
 * only on the bullet's first line — plan prose wraps, and forcing the
 * clause onto line one would push authors toward one-line tasks, which is
 * worse writing for a marginal parsing gain.
 *
 * :param lines: PLAN.md split into lines
 * :returns: one entry per undeclared task — the line to anchor on and the issue id
 */
export declare function judgeVerifyDeclarations(lines: string[]): {
    line: number;
    issue: string;
}[];
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
