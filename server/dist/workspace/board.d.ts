export type WorkstreamStatus = "queued" | "active" | "blocked" | "done";
export interface Workstream {
    title: string;
    project: string;
    status: WorkstreamStatus;
    issue?: string;
    session?: string;
    note?: string;
    updated: string;
}
/**
 * Single-writer merge-patch, config_set-style: workstreams merge by id
 * (patch fields over existing; `null` deletes). `title` + `project` are
 * required on CREATE (optional on update, where they carry over from the
 * existing entry); `status` defaults to "queued" on create. `project` must
 * name a workspace member, `status` must be a known enum value, and both
 * are checked -- along with the required-on-create fields -- before ANY
 * write happens, so a rejected patch leaves the board file untouched.
 * `updated` is always stamped server-side, never taken from the patch.
 */
export declare function boardUpdate(launchDir: string, patch: Record<string, Partial<Workstream> | null>): {
    workstreams: number;
};
/** Missing board file -> empty board with zeroed counts. Ids sorted, counts derived, deterministic. */
export declare function boardGet(launchDir: string): {
    workstreams: Record<string, Workstream>;
    counts: Record<WorkstreamStatus, number>;
};
