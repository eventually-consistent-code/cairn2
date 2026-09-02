import type { DocsConnector, Page } from "./types.js";
export interface PublishResult {
    root: Page;
    published: number;
    pages: Array<{
        title: string;
        url: string;
    }>;
    /** Release stamp applied to every published page — the project's
     *  package.json version. Absent = project has no version to stamp. */
    releaseVersion?: string;
    /** Remote pages under the project root with no local counterpart (#126).
     *  Reported only — cairn never deletes remote pages; pruning a shared docs
     *  space is a human decision. */
    orphans?: Array<{
        title: string;
        url: string;
    }>;
    /** Degraded-but-successful post-publish step (e.g. auto-commit skipped,
     *  orphan pages left behind). */
    warning?: string;
}
/** Default project name: the repo directory's basename. */
export declare function defaultProjectName(projectDir: string): string;
/**
 * Full documentation publish: README becomes the landing page, docs/ (plus a
 * root CHANGELOG.md) becomes the child page tree, and the landing page gains
 * a Documentation section linking the top-level children. Idempotent — pages
 * are matched by title + ancestry and updated in place.
 */
export declare function publishTree(connector: DocsConnector, projectDir: string, projectName?: string): Promise<PublishResult>;
/**
 * The walking-skeleton publish: README.md only, no child tree. Kept as the
 * degenerate case — publishTree with an empty docs/ behaves identically.
 */
export declare function publishReadme(connector: DocsConnector, projectDir: string, projectName?: string): Promise<PublishResult>;
