export interface PhaseInfo {
    number: number;
    dir: string;
    name: string;
    hasContext: boolean;
    hasResearch: boolean;
    hasPlan: boolean;
    hasVerification: boolean;
    issues: string[];
    parseError?: string;
}
export declare function projectStatus(projectDir: string): {
    hasProject: boolean;
    hasRoadmap: boolean;
    phases: PhaseInfo[];
};
