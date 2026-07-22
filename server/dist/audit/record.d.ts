export type AuditSeverity = "critical" | "important" | "minor";
export interface AuditFinding {
    severity: AuditSeverity;
    title: string;
    detail?: string;
    issue?: string;
}
export declare function writeAuditRecord(projectDir: string, scope: string, verdict: "pass" | "findings", findings: AuditFinding[]): {
    path: string;
    findings: number;
};
export declare function listAuditRecords(projectDir: string): Array<{
    scope: string;
    date: string;
    verdict: string;
    path: string;
}>;
