export interface DocsCapability {
    /** Pages can nest under parent pages (tree, not flat list). */
    hasPageTree: boolean;
    /** Binary attachments can be uploaded to a page. */
    hasAttachments: boolean;
    /** Pages can carry labels/tags. */
    hasLabels: boolean;
    /** Backend renders directory/landing indexes natively — the publisher
     *  must not append generated TOC markdown. */
    hasNativeToc: boolean;
}
export interface Page {
    id: string;
    title: string;
    parentId?: string;
    /** Backend version counter, when the product exposes one. */
    version?: number;
    url: string;
}
export interface PageSpec {
    title: string;
    /** Markdown source — the adapter converts to its native body format. */
    markdown: string;
    /** Omitted = top of the project tree (child of the project root page). */
    parentId?: string;
    /** Hint: this page will have child pages. Filesystem backends need to
     *  know folder-vs-file at create time; API backends may ignore it. */
    container?: boolean;
    /** Source file/dir basename (e.g. "00-quickstart.md"). Filesystem backends
     *  store under this name so repo-relative links between docs keep
     *  resolving; API backends may ignore it. */
    sourceName?: string;
}
export interface DocsConnector {
    readonly capabilities: DocsCapability;
    /**
     * Ensure the project's root (landing) container exists and return it.
     * Idempotent — an existing root is returned, never duplicated.
     */
    ensureRoot(projectName: string): Promise<Page>;
    getPage(id: string): Promise<Page>;
    /** Locate a page by title under a parent — the identity probe for idempotent sync. */
    findPage(title: string, parentId?: string): Promise<Page | null>;
    listChildren(parentId: string): Promise<Page[]>;
    createPage(spec: PageSpec): Promise<Page>;
    updatePage(id: string, spec: PageSpec): Promise<Page>;
    /** Post-publish hook (e.g. auto-commit). Returns a warning string when the
     *  step degraded, undefined when clean or not applicable. */
    finalize?(): Promise<string | undefined>;
}
