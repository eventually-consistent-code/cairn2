export interface PlanFinding {
    type: "contract-drift" | "unanchored-threshold";
    plan: string;
    line: number;
    detail: string;
    counterpart?: {
        plan: string;
        line: number;
    };
}
export declare function planCheck(projectDir: string, phase?: number): {
    findings: PlanFinding[];
    scanned: number;
};
