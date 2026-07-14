export declare const plansRoot: (projectDir: string) => string;
export declare function slugify(name: string): string;
export declare function phaseDirName(number: number, slug: string): string;
export declare const PROJECT_TEMPLATE: (name: string) => string;
export declare const ROADMAP_TEMPLATE: (name: string) => string;
export declare const CONTEXT_TEMPLATE: (number: number, name: string) => string;
export declare const PLAN_TEMPLATE: (number: number, name: string) => string;
export declare const RESEARCH_TEMPLATE: (number: number, name: string) => string;
export declare function scaffoldProject(projectDir: string, name: string): {
    created: string[];
    skipped: string[];
};
export declare function scaffoldPhase(projectDir: string, number: number, name: string, opts?: {
    research?: boolean;
}): {
    dir: string;
    created: string[];
    skipped: string[];
};
export declare function readPlanIssues(projectDir: string, phaseDir: string): string[];
export declare function writePlanIssues(projectDir: string, phaseDir: string, issues: string[]): void;
