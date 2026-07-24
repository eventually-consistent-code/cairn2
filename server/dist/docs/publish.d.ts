import type { DocsConnector, Page } from "./types.js";
export interface PublishResult {
    root: Page;
    published: number;
}
/** Default project name: the repo directory's basename. */
export declare function defaultProjectName(projectDir: string): string;
/**
 * The walking-skeleton publish: README.md becomes (or refreshes) the
 * project's landing page in the docs backend. Idempotent — the root is
 * located by name and updated in place.
 */
export declare function publishReadme(connector: DocsConnector, projectDir: string, projectName?: string): Promise<PublishResult>;
