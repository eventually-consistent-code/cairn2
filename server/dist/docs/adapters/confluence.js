import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginateCursor } from "../../tracker/http.js";
import { markdownToStorage } from "../markdown.js";
export const configSchema = z.object({
    /** Site wiki base, e.g. https://your-domain.atlassian.net/wiki */
    baseUrl: z.string().url(),
    spaceKey: z.string().min(1),
    emailEnv: z.string().default("CONFLUENCE_EMAIL"),
    tokenEnv: z.string().default("CONFLUENCE_API_TOKEN"),
});
export function make(config, fetchImpl) {
    return new ConfluenceConnector(config, fetchImpl);
}
export function resolveConfluenceAuth(cfg) {
    const email = process.env[cfg.emailEnv];
    const token = process.env[cfg.tokenEnv];
    if (!email || !token) {
        throw new CairnError("AUTH_MISSING", "no Confluence credentials", `export ${cfg.emailEnv} and ${cfg.tokenEnv} (create a token at https://id.atlassian.com/manage-profile/security/api-tokens — Jira and Confluence share Atlassian API tokens)`);
    }
    return { email, token };
}
export class ConfluenceConnector {
    cfg;
    fetchImpl;
    authProvider;
    capabilities = {
        hasPageTree: true, hasAttachments: true, hasLabels: true,
    };
    space;
    constructor(cfg, fetchImpl = fetch, authProvider = () => resolveConfluenceAuth(cfg)) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
        this.authProvider = authProvider;
    }
    headers() {
        const { email, token } = this.authProvider();
        const basic = Buffer.from(`${email}:${token}`).toString("base64");
        return {
            authorization: `Basic ${basic}`,
            accept: "application/json",
            "content-type": "application/json",
        };
    }
    url(path) {
        return `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
    }
    async api(method, path, body) {
        return fetchJson(this.fetchImpl, this.url(path), {
            method,
            headers: this.headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
        }, { context: "confluence" });
    }
    normalize(raw) {
        return {
            id: String(raw.id),
            title: raw.title,
            parentId: raw.parentId == null ? undefined : String(raw.parentId),
            version: raw.version?.number,
            url: raw._links?.webui ? this.url(raw._links.webui) : this.url(`/pages/${raw.id}`),
        };
    }
    /** Resolve and memoize the configured space (id + homepage). */
    async getSpace() {
        if (this.space)
            return this.space;
        const resp = await this.api("GET", `/api/v2/spaces?keys=${encodeURIComponent(this.cfg.spaceKey)}&limit=1`);
        const found = resp.results?.[0];
        if (!found) {
            throw new CairnError("NOT_FOUND", `Confluence space '${this.cfg.spaceKey}' not found`, "check docs.config.spaceKey in cairn.json");
        }
        this.space = {
            id: String(found.id), key: found.key,
            homepageId: found.homepageId == null ? "" : String(found.homepageId),
        };
        return this.space;
    }
    async ensureRoot(projectName) {
        const space = await this.getSpace();
        const existing = await this.findPage(projectName, space.homepageId || undefined);
        if (existing)
            return existing;
        return this.createPage({
            title: projectName,
            markdown: "",
            parentId: space.homepageId || undefined,
        });
    }
    async getPage(id) {
        const raw = await this.api("GET", `/api/v2/pages/${encodeURIComponent(id)}`);
        return this.normalize(raw);
    }
    async findPage(title, parentId) {
        const space = await this.getSpace();
        const raws = await paginateCursor(this.fetchImpl, this.url(`/api/v2/pages?title=${encodeURIComponent(title)}&space-id=${encodeURIComponent(space.id)}&limit=50`), { headers: this.headers() }, (body) => {
            const b = body;
            return { items: b.results ?? [], next: b._links?.next };
        }, { context: "confluence" });
        const match = raws.map((r) => this.normalize(r))
            .find((p) => parentId === undefined || p.parentId === parentId);
        return match ?? null;
    }
    async listChildren(parentId) {
        const raws = await paginateCursor(this.fetchImpl, this.url(`/api/v2/pages/${encodeURIComponent(parentId)}/children?limit=50`), { headers: this.headers() }, (body) => {
            const b = body;
            return { items: b.results ?? [], next: b._links?.next };
        }, { context: "confluence" });
        // The children endpoint omits parentId — it is the queried parent by definition.
        return raws.map((r) => this.normalize({ ...r, parentId }));
    }
    async createPage(spec) {
        const space = await this.getSpace();
        const raw = await this.api("POST", "/api/v2/pages", {
            spaceId: space.id,
            status: "current",
            title: spec.title,
            ...(spec.parentId ? { parentId: spec.parentId } : {}),
            body: { representation: "storage", value: markdownToStorage(spec.markdown) },
        });
        return this.normalize(raw);
    }
    async updatePage(id, spec) {
        const current = await this.getPage(id);
        const raw = await this.api("PUT", `/api/v2/pages/${encodeURIComponent(id)}`, {
            id,
            status: "current",
            title: spec.title,
            body: { representation: "storage", value: markdownToStorage(spec.markdown) },
            version: { number: (current.version ?? 0) + 1 },
        });
        return this.normalize(raw);
    }
}
