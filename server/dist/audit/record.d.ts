export type AuditSeverity = "critical" | "important" | "minor";
export interface AuditFinding {
    severity: AuditSeverity;
    title: string;
    /**
     * The concrete failure — "inputs/state → wrong output/crash". Required
     * since phase 21: a finding without one is a hunch, and the prose bar
     * ("name the scenario or cut it") is now enforced here, not asked for.
     */
    failure_scenario: string;
    detail?: string;
    issue?: string;
}
export declare function writeAuditRecord(projectDir: string, scope: string, verdict: "pass" | "findings", findings: AuditFinding[]): {
    path: string;
    findings: number;
};
export interface AuditRecordSummary {
    scope: string;
    date: string;
    verdict: string;
    path: string;
    /** Revision stamp — undefined on records written before phase 21 or outside git. */
    commit?: string;
    dirty?: boolean;
}
export declare function listAuditRecords(projectDir: string): AuditRecordSummary[];
