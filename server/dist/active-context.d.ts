export interface ActiveContextState {
    phase?: number;
    issueId?: string;
}
export declare class ActiveContext {
    private readonly path;
    private state;
    constructor(projectDir: string);
    get(): ActiveContextState;
    set(patch: {
        phase?: number | null;
        issueId?: string | null;
    }): void;
}
