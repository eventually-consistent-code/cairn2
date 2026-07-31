import { z } from "zod";
import { type FetchLike } from "../../tracker/http.js";
import type { ProbeResult } from "../../tracker/types.js";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "../types.js";
export declare const configSchema: z.ZodObject<{
    /** Site wiki base, e.g. https://your-domain.atlassian.net/wiki */
    baseUrl: z.ZodString;
    spaceKey: z.ZodString;
    emailEnv: z.ZodDefault<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
    authMode: z.ZodOptional<z.ZodEnum<["site", "gateway"]>>;
}, "strip", z.ZodTypeAny, {
    baseUrl: string;
    spaceKey: string;
    emailEnv: string;
    tokenEnv: string;
    authMode?: "site" | "gateway" | undefined;
}, {
    baseUrl: string;
    spaceKey: string;
    emailEnv?: string | undefined;
    tokenEnv?: string | undefined;
    authMode?: "site" | "gateway" | undefined;
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
    /** Builds a human-facing site URL — always the site host (with /wiki),
     *  in both site and gateway auth modes. Used for normalized `url:` fields. */
    private url;
    private cloudId;
    /** Site origin for tenant_info discovery — baseUrl minus any /wiki suffix. */
    private siteOrigin;
    private gatewayActive;
    private resolveCloudId;
    /** Resolves the base URL for an API call — site base (with /wiki), or the
     *  scoped-token gateway (cloudId + /wiki, mirroring the site's own path
     *  shape) once cloudId is known. */
    private apiBase;
    /** Builds a full API-call URL: site or gateway base + path. The single site
     *  every API call (including attachment uploads) routes through, so a
     *  third URL site can't quietly diverge from this decision again. Distinct
     *  from `url()`, which always stays site-based for human-facing links. */
    private apiUrl;
    private api;
    private normalize;
    /** Resolve and memoize the configured space (id + homepage). */
    private getSpace;
    /** Preflight: resolving the configured space is the cheapest authenticated
     *  call this connector has — the same one every other method needs first. */
    probe(): Promise<ProbeResult>;
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
