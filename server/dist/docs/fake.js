// In-memory DocsConnector test double — same role as tracker/adapters/fake.ts.
// Enforces the space-wide unique-title rule so tests exercise the same
// constraint surface as Confluence.
import { z } from "zod";
import { CairnError } from "../errors.js";
export const configSchema = z.object({});
export function make() {
    return new FakeDocsConnector();
}
export class FakeDocsConnector {
    capabilities = {
        hasPageTree: true, hasAttachments: true, hasLabels: false, hasNativeToc: false,
    };
    pages = new Map();
    /** pageId → attachment filenames, deduplicated like Confluence would. */
    attachments = new Map();
    seq = 0;
    storeImages(pageId, spec) {
        if (!spec.images?.length)
            return;
        const names = this.attachments.get(pageId) ?? [];
        for (const img of spec.images) {
            if (!names.includes(img.filename))
                names.push(img.filename);
        }
        this.attachments.set(pageId, names);
    }
    async ensureRoot(projectName) {
        for (const p of this.pages.values())
            if (p.title === projectName)
                return p;
        return this.createPage({ title: projectName, markdown: "" });
    }
    async getPage(id) {
        const p = this.pages.get(id);
        if (!p)
            throw new CairnError("NOT_FOUND", `no page ${id}`);
        return p;
    }
    async findPage(title, parentId) {
        for (const p of this.pages.values()) {
            if (p.title === title && (parentId === undefined || p.parentId === parentId))
                return p;
        }
        return null;
    }
    async listChildren(parentId) {
        return [...this.pages.values()].filter((p) => p.parentId === parentId);
    }
    async createPage(spec) {
        for (const p of this.pages.values()) {
            if (p.title === spec.title) {
                throw new CairnError("TRACKER_DOWN", `[fake-docs] title '${spec.title}' already exists in the space`);
            }
        }
        const page = {
            id: String(++this.seq), title: spec.title, parentId: spec.parentId,
            version: 1, url: `fake://page/${this.seq}`, markdown: spec.markdown,
        };
        this.pages.set(page.id, page);
        this.storeImages(page.id, spec);
        return page;
    }
    async updatePage(id, spec) {
        const prev = this.pages.get(id);
        if (!prev)
            throw new CairnError("NOT_FOUND", `no page ${id}`);
        const page = {
            ...prev, title: spec.title, markdown: spec.markdown,
            parentId: spec.parentId ?? prev.parentId,
            version: (prev.version ?? 0) + 1,
        };
        this.pages.set(id, page);
        this.storeImages(id, spec);
        return page;
    }
    async probe() {
        return { verdict: "ok" };
    }
}
