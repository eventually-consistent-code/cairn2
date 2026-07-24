import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginateCursor, type FetchLike } from "../../tracker/http.js";
import { markdownToStorage } from "../markdown.js";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "../types.js";

export const configSchema = z.object({
  /** Site wiki base, e.g. https://your-domain.atlassian.net/wiki */
  baseUrl: z.string().url(),
  spaceKey: z.string().min(1),
  emailEnv: z.string().default("CONFLUENCE_EMAIL"),
  tokenEnv: z.string().default("CONFLUENCE_API_TOKEN"),
});

type ConfluenceConfig = z.infer<typeof configSchema>;

export function make(config: ConfluenceConfig, fetchImpl?: FetchLike): DocsConnector {
  return new ConfluenceConnector(config, fetchImpl);
}

export function resolveConfluenceAuth(cfg: ConfluenceConfig): { email: string; token: string } {
  const email = process.env[cfg.emailEnv];
  const token = process.env[cfg.tokenEnv];
  if (!email || !token) {
    throw new CairnError("AUTH_MISSING", "no Confluence credentials",
      `export ${cfg.emailEnv} and ${cfg.tokenEnv} (create a token at https://id.atlassian.com/manage-profile/security/api-tokens — Jira and Confluence share Atlassian API tokens)`);
  }
  return { email, token };
}

interface ConfluenceSpace { id: string; key: string; homepageId: string }

interface RawPage {
  id: string | number;
  title: string;
  parentId?: string | number | null;
  version?: { number: number };
  _links?: { webui?: string };
}

export class ConfluenceConnector implements DocsConnector {
  readonly capabilities: DocsCapability = {
    hasPageTree: true, hasAttachments: true, hasLabels: true,
  };

  private space: ConfluenceSpace | undefined;

  constructor(
    private readonly cfg: ConfluenceConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly authProvider: () => { email: string; token: string } =
      () => resolveConfluenceAuth(cfg),
  ) {}

  private headers(): Record<string, string> {
    const { email, token } = this.authProvider();
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    return {
      authorization: `Basic ${basic}`,
      accept: "application/json",
      "content-type": "application/json",
    };
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    return fetchJson(this.fetchImpl, this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { context: "confluence" });
  }

  private normalize(raw: RawPage): Page {
    return {
      id: String(raw.id),
      title: raw.title,
      parentId: raw.parentId == null ? undefined : String(raw.parentId),
      version: raw.version?.number,
      url: raw._links?.webui ? this.url(raw._links.webui) : this.url(`/pages/${raw.id}`),
    };
  }

  /** Resolve and memoize the configured space (id + homepage). */
  private async getSpace(): Promise<ConfluenceSpace> {
    if (this.space) return this.space;
    const resp = await this.api("GET",
      `/api/v2/spaces?keys=${encodeURIComponent(this.cfg.spaceKey)}&limit=1`) as
      { results?: Array<{ id: string | number; key: string; homepageId?: string | number }> };
    const found = resp.results?.[0];
    if (!found) {
      throw new CairnError("NOT_FOUND", `Confluence space '${this.cfg.spaceKey}' not found`,
        "check docs.config.spaceKey in cairn.json");
    }
    this.space = {
      id: String(found.id), key: found.key,
      homepageId: found.homepageId == null ? "" : String(found.homepageId),
    };
    return this.space;
  }

  async ensureRoot(projectName: string): Promise<Page> {
    const space = await this.getSpace();
    const existing = await this.findPage(projectName,
      space.homepageId || undefined);
    if (existing) return existing;
    return this.createPage({
      title: projectName,
      markdown: "",
      parentId: space.homepageId || undefined,
    });
  }

  async getPage(id: string): Promise<Page> {
    const raw = await this.api("GET", `/api/v2/pages/${encodeURIComponent(id)}`) as RawPage;
    return this.normalize(raw);
  }

  async findPage(title: string, parentId?: string): Promise<Page | null> {
    const space = await this.getSpace();
    const raws = await paginateCursor(this.fetchImpl,
      this.url(`/api/v2/pages?title=${encodeURIComponent(title)}&space-id=${encodeURIComponent(space.id)}&limit=50`),
      { headers: this.headers() },
      (body) => {
        const b = body as { results?: unknown[]; _links?: { next?: string } };
        return { items: b.results ?? [], next: b._links?.next };
      },
      { context: "confluence" }) as RawPage[];
    const match = raws.map((r) => this.normalize(r))
      .find((p) => parentId === undefined || p.parentId === parentId);
    return match ?? null;
  }

  async listChildren(parentId: string): Promise<Page[]> {
    const raws = await paginateCursor(this.fetchImpl,
      this.url(`/api/v2/pages/${encodeURIComponent(parentId)}/children?limit=50`),
      { headers: this.headers() },
      (body) => {
        const b = body as { results?: unknown[]; _links?: { next?: string } };
        return { items: b.results ?? [], next: b._links?.next };
      },
      { context: "confluence" }) as RawPage[];
    // The children endpoint omits parentId — it is the queried parent by definition.
    return raws.map((r) => this.normalize({ ...r, parentId }));
  }

  async createPage(spec: PageSpec): Promise<Page> {
    const space = await this.getSpace();
    const raw = await this.api("POST", "/api/v2/pages", {
      spaceId: space.id,
      status: "current",
      title: spec.title,
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
      body: { representation: "storage", value: markdownToStorage(spec.markdown) },
    }) as RawPage;
    return this.normalize(raw);
  }

  async updatePage(id: string, spec: PageSpec): Promise<Page> {
    const current = await this.getPage(id);
    const raw = await this.api("PUT", `/api/v2/pages/${encodeURIComponent(id)}`, {
      id,
      status: "current",
      title: spec.title,
      body: { representation: "storage", value: markdownToStorage(spec.markdown) },
      version: { number: (current.version ?? 0) + 1 },
    }) as RawPage;
    return this.normalize(raw);
  }
}
