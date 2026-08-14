import { z } from "zod";
import type { ProbeResult } from "../../tracker/types.js";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "../types.js";
export declare const configSchema: z.ZodObject<{
    sitePath: z.ZodString;
    docsDir: z.ZodDefault<z.ZodString>;
    autoCommit: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
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
    /** Preflight: no network here — the "cheap authenticated call" is the same
     *  sitePath existence check every other method runs first. */
    probe(): Promise<ProbeResult>;
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
