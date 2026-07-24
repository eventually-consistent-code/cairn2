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
    ensureRoot(projectName: string): Promise<Page>;
    getPage(id: string): Promise<Page>;
    findPage(title: string, parentId?: string): Promise<Page | null>;
    listChildren(parentId: string): Promise<Page[]>;
    createPage(spec: PageSpec): Promise<Page>;
    updatePage(id: string, spec: PageSpec): Promise<Page>;
}
export {};
