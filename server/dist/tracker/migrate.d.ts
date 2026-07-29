import type { Tracker } from "./types.js";
export interface MigrateResult {
    /** old issue id → new issue id */
    remap: Record<string, string>;
    phaseRemap: Record<string, string>;
    counts: {
        phases: number;
        issues: number;
        comments: number;
        worklogs: number;
        links: number;
    };
    warnings: string[];
}
/**
 * Post-migration bookkeeping on the LOCAL store: write MIGRATED.json (the
 * durable remap record) and mark config.json migratedTo. The only mutation
 * migration ever makes to the source. Returns the record's path.
 */
export declare function finalizeMigration(storeDir: string, targetType: string, result: MigrateResult): string;
export declare function migrateTracker(src: Tracker, dst: Tracker): Promise<MigrateResult>;
