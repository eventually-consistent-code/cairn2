import { z } from "zod";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "../types.js";
export declare const configSchema: z.ZodObject<{
    /** Docusaurus site checkout, absolute or relative to the cairn project. */
    sitePath: z.ZodString;
    /** Docs root inside the site. Created if missing. */
    docsDir: z.ZodDefault<z.ZodString>;
    /** Commit the project folder in the site repo after publish. Never pushes. */
    autoCommit: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    sitePath: string;
    docsDir: string;
    autoCommit: boolean;
}, {
    sitePath: string;
    docsDir?: string | undefined;
    autoCommit?: boolean | undefined;
}>;
export type DocusaurusConfig = z.infer<typeof configSchema>;
export declare function make(config: DocusaurusConfig): DocsConnector;
/** "Quick Start!" → "quick-start" — filename/id form of a page title. */
export declare function slugify(title: string): string;
export declare class DocusaurusConnector implements DocsConnector {
    private readonly cfg;
    readonly capabilities: DocsCapability;
    private readonly siteAbs;
    private readonly docsAbs;
    private rootId;
    private projectName;
    private probed;
    constructor(cfg: DocusaurusConfig);
    /** Sanity probe: sitePath must hold a Docusaurus site. Cached after first pass. */
    private probeSite;
    private abs;
    private isDir;
    private readCategory;
    private writeCategory;
    private pageFor;
    /** Sidebar order = arrival order: existing page-ish siblings + 1. */
    private nextPosition;
    private parentDirId;
    ensureRoot(projectName: string): Promise<Page>;
    getPage(id: string): Promise<Page>;
    findPage(title: string, parentId?: string): Promise<Page | null>;
    private findInDir;
    private findRecursive;
    private childPages;
    listChildren(parentId: string): Promise<Page[]>;
    /** Filesystem attachment story: write each image under the page's dir at
     *  its original relative ref — the markdown keeps resolving untouched. */
    private writeImages;
    createPage(spec: PageSpec): Promise<Page>;
    updatePage(id: string, spec: PageSpec): Promise<Page>;
    /**
     * Directory page: non-empty markdown → index.md landing (native category
     * index); empty markdown → a generated-index _category_.json and no index.md.
     */
    private writeContainer;
    private body;
    finalize(): Promise<string | undefined>;
}
