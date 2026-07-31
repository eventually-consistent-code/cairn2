import { z } from "zod";
import type { ProbeResult } from "../tracker/types.js";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "./types.js";
export declare const configSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare function make(): DocsConnector;
interface StoredPage extends Page {
    markdown: string;
}
export declare class FakeDocsConnector implements DocsConnector {
    readonly capabilities: DocsCapability;
    readonly pages: Map<string, StoredPage>;
    /** pageId → attachment filenames, deduplicated like Confluence would. */
    readonly attachments: Map<string, string[]>;
    private seq;
    private storeImages;
    ensureRoot(projectName: string): Promise<Page>;
    getPage(id: string): Promise<Page>;
    findPage(title: string, parentId?: string): Promise<Page | null>;
    listChildren(parentId: string): Promise<Page[]>;
    createPage(spec: PageSpec): Promise<Page>;
    updatePage(id: string, spec: PageSpec): Promise<Page>;
    probe(): Promise<ProbeResult>;
}
export {};
