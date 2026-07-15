export type ProvenanceStatus = "unchanged" | "changed" | "deleted" | "unknown";
export declare function checkProvenance(projectDir: string, file: string, commit: string): ProvenanceStatus;
export interface StaleCheck {
    stale: boolean;
    reasons: string[];
}
export declare function checkCardStaleness(projectDir: string, provenance: Array<{
    file: string;
    commit: string;
}>): StaleCheck;
