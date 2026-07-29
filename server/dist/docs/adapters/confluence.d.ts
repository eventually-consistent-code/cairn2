import { z } from "zod";
import { type FetchLike } from "../../tracker/http.js";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "../types.js";
export declare const configSchema: z.ZodObject<{
    /** Site wiki base, e.g. https://your-domain.atlassian.net/wiki */
    baseUrl: z.ZodString;
    spaceKey: z.ZodString;
    emailEnv: z.ZodDefault<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    baseUrl: string;
    spaceKey: string;
    emailEnv: string;
    tokenEnv: string;
}, {
    baseUrl: string;
    spaceKey: string;
    emailEnv?: string | undefined;
    tokenEnv?: string | undefined;
}>;
type ConfluenceConfig = z.infer<typeof configSchema>;
export declare function make(config: ConfluenceConfig, fetchImpl?: FetchLike): DocsConnector;
export declare function resolveConfluenceAuth(cfg: ConfluenceConfig): {
    email: string;
    token: string;
};
export declare class ConfluenceConnector implements DocsConnector {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly authProvider;
    readonly capabilities: DocsCapability;
    private space;
    constructor(cfg: ConfluenceConfig, fetchImpl?: FetchLike, authProvider?: () => {
        email: string;
        token: string;
    });
    private headers;
    private url;
    private api;
    private normalize;
    /** Resolve and memoize the configured space (id + homepage). */
    private getSpace;
    /**
     * Find the project's folder by title (case-insensitive) anywhere in the
     * space. Folders have no title-filtered v2 listing, so this goes through
     * CQL search (v1 endpoint, same auth).
     */
    private findFolder;
    private createFolder;
    /**
     * Project layout mirrors the space convention: a FOLDER named for the
     * project under the space root, with the landing page (and doc tree)
     * inside it.
     */
    ensureRoot(projectName: string): Promise<Page>;
    getPage(id: string): Promise<Page>;
    findPage(title: string, parentId?: string): Promise<Page | null>;
    listChildren(parentId: string): Promise<Page[]>;
    /** ref → filename map for the storage conversion (renders ri:attachment). */
    private static imageMap;
    /**
     * Upload one image as a page attachment — idempotent by filename: an
     * existing attachment gets its data updated, never a duplicate. Best-effort:
     * a failed upload logs one warning and the page publish stands (the body
     * already references the filename; a later republish heals it).
     */
    private uploadImages;
    createPage(spec: PageSpec): Promise<Page>;
    updatePage(id: string, spec: PageSpec): Promise<Page>;
}
export {};
