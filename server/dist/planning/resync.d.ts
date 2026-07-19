export interface OutOfBandCommit {
    sha: string;
    subject: string;
    files: string[];
}
export interface ResyncReport {
    outOfBand: OutOfBandCommit[];
    sinceSha: string | null;
    headSha: string;
    initialized?: boolean;
}
export declare function resyncReport(projectDir: string): ResyncReport;
