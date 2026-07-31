import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginateCursor, type FetchLike } from "../../tracker/http.js";
import { markdownToStorage } from "../markdown.js";
import type { DocsCapability, DocsConnector, Page, PageImage, PageSpec } from "../types.js";

export const configSchema = z.object({
  /** Site wiki base, e.g. https://your-domain.atlassian.net/wiki */
  baseUrl: z.string().url(),
  spaceKey: z.string().min(1),
  emailEnv: z.string().default("CONFLUENCE_EMAIL"),
  tokenEnv: z.string().default("CONFLUENCE_API_TOKEN"),
  // Atlassian's scoped tokens (ATCTT-prefixed) only authenticate through the
  // api.atlassian.com/ex/confluence/{cloudId} gateway, never the site URL
  // directly. Detected automatically from the token shape; set this to force
  // one mode or the other.
  authMode: z.enum(["site", "gateway"]).optional(),
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
    hasPageTree: true, hasAttachments: true, hasLabels: true, hasNativeToc: false,
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

  /** Builds a human-facing site URL — always the site host (with /wiki),
   *  in both site and gateway auth modes. Used for normalized `url:` fields. */
  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
  }

  // Scoped-token gateway support (CRN-49). Classic tokens keep hitting the
  // site URL directly; ATCTT-prefixed scoped tokens only authenticate
  // through api.atlassian.com/ex/confluence/{cloudId} — cloudId is resolved
  // once per instance via an *unauthenticated* GET against the site's own
  // /_edge/tenant_info (served at the bare site origin, never under /wiki).
  private cloudId: string | undefined;

  /** Site origin for tenant_info discovery — baseUrl minus any /wiki suffix. */
  private siteOrigin(): string {
    return this.cfg.baseUrl.replace(/\/$/, "").replace(/\/wiki$/, "");
  }

  private gatewayActive(token: string): boolean {
    if (this.cfg.authMode === "site") return false;
    if (this.cfg.authMode === "gateway") return true;
    return token.startsWith("ATCTT");
  }

  private async resolveCloudId(): Promise<string> {
    if (this.cloudId === undefined) {
      const info = (await fetchJson(this.fetchImpl, `${this.siteOrigin()}/_edge/tenant_info`,
        { method: "GET" }, { context: "confluence tenant_info" })) as { cloudId: string };
      this.cloudId = info.cloudId;
    }
    return this.cloudId;
  }

  /** Resolves the base URL for an API call — site base (with /wiki), or the
   *  scoped-token gateway (cloudId + /wiki, mirroring the site's own path
   *  shape) once cloudId is known. */
  private async apiBase(): Promise<string> {
    const { token } = this.authProvider();
    if (!this.gatewayActive(token)) return this.cfg.baseUrl.replace(/\/$/, "");
    const cloudId = await this.resolveCloudId();
    return `https://api.atlassian.com/ex/confluence/${cloudId}/wiki`;
  }

  /** Builds a full API-call URL: site or gateway base + path. The single site
   *  every API call (including attachment uploads) routes through, so a
   *  third URL site can't quietly diverge from this decision again. Distinct
   *  from `url()`, which always stays site-based for human-facing links. */
  private async apiUrl(path: string): Promise<string> {
    return `${await this.apiBase()}${path}`;
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    return fetchJson(this.fetchImpl, await this.apiUrl(path), {
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

  /**
   * Find the project's folder by title (case-insensitive) anywhere in the
   * space. Folders have no title-filtered v2 listing, so this goes through
   * CQL search (v1 endpoint, same auth).
   */
  private async findFolder(title: string): Promise<string | null> {
    const resp = await this.api("GET",
      `/rest/api/search?cql=${encodeURIComponent(`type=folder and space="${this.cfg.spaceKey}"`)}&limit=100`) as
      { results?: Array<{ content?: { id?: string | number; title?: string } }> };
    const match = (resp.results ?? [])
      .map((r) => r.content)
      .find((c) => c?.title?.toLowerCase() === title.toLowerCase());
    return match?.id == null ? null : String(match.id);
  }

  private async createFolder(title: string, parentId?: string): Promise<string> {
    const space = await this.getSpace();
    const raw = await this.api("POST", "/api/v2/folders", {
      spaceId: space.id,
      title,
      ...(parentId ? { parentId } : {}),
    }) as { id: string | number };
    return String(raw.id);
  }

  /**
   * Project layout mirrors the space convention: a FOLDER named for the
   * project under the space root, with the landing page (and doc tree)
   * inside it.
   */
  async ensureRoot(projectName: string): Promise<Page> {
    const space = await this.getSpace();
    const folderId = await this.findFolder(projectName)
      ?? await this.createFolder(projectName, space.homepageId || undefined);
    const existing = await this.findPage(projectName, folderId);
    if (existing) return existing;
    return this.createPage({ title: projectName, markdown: "", parentId: folderId });
  }

  async getPage(id: string): Promise<Page> {
    const raw = await this.api("GET", `/api/v2/pages/${encodeURIComponent(id)}`) as RawPage;
    return this.normalize(raw);
  }

  async findPage(title: string, parentId?: string): Promise<Page | null> {
    const space = await this.getSpace();
    const raws = await paginateCursor(this.fetchImpl,
      await this.apiUrl(`/api/v2/pages?title=${encodeURIComponent(title)}&space-id=${encodeURIComponent(space.id)}&limit=50`),
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
      await this.apiUrl(`/api/v2/pages/${encodeURIComponent(parentId)}/children?limit=50`),
      { headers: this.headers() },
      (body) => {
        const b = body as { results?: unknown[]; _links?: { next?: string } };
        return { items: b.results ?? [], next: b._links?.next };
      },
      { context: "confluence" }) as RawPage[];
    // The children endpoint omits parentId — it is the queried parent by definition.
    return raws.map((r) => this.normalize({ ...r, parentId }));
  }

  /** ref → filename map for the storage conversion (renders ri:attachment). */
  private static imageMap(spec: PageSpec): Map<string, string> | undefined {
    if (!spec.images?.length) return undefined;
    return new Map(spec.images.map((i) => [i.ref, i.filename]));
  }

  /**
   * Upload one image as a page attachment — idempotent by filename: an
   * existing attachment gets its data updated, never a duplicate. Best-effort:
   * a failed upload logs one warning and the page publish stands (the body
   * already references the filename; a later republish heals it).
   */
  private async uploadImages(pageId: string, images: PageImage[] | undefined): Promise<void> {
    for (const img of images ?? []) {
      try {
        const existing = await this.api("GET",
          `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?filename=${encodeURIComponent(img.filename)}`) as
          { results?: Array<{ id: string }> };
        const attId = existing.results?.[0]?.id;
        const path = attId
          ? `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(attId)}/data`
          : `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(img.data)], { type: img.mediaType }), img.filename);
        const { email, token } = this.authProvider();
        await fetchJson(this.fetchImpl, await this.apiUrl(path), {
          method: "POST",
          // No content-type — fetch sets the multipart boundary itself.
          headers: {
            authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
            accept: "application/json",
            "X-Atlassian-Token": "nocheck",
          },
          body: form,
        }, { context: "confluence attachment" });
      } catch (e) {
        console.error(`[cairn] confluence: attachment '${img.filename}' on page ${pageId} skipped: ${e}`);
      }
    }
  }

  async createPage(spec: PageSpec): Promise<Page> {
    const space = await this.getSpace();
    const raw = await this.api("POST", "/api/v2/pages", {
      spaceId: space.id,
      status: "current",
      title: spec.title,
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
      body: { representation: "storage",
        value: markdownToStorage(spec.markdown, ConfluenceConnector.imageMap(spec)) },
    }) as RawPage;
    const page = this.normalize(raw);
    await this.uploadImages(page.id, spec.images);
    return page;
  }

  async updatePage(id: string, spec: PageSpec): Promise<Page> {
    const current = await this.getPage(id);
    const raw = await this.api("PUT", `/api/v2/pages/${encodeURIComponent(id)}`, {
      id,
      status: "current",
      title: spec.title,
      body: { representation: "storage",
        value: markdownToStorage(spec.markdown, ConfluenceConnector.imageMap(spec)) },
      version: { number: (current.version ?? 0) + 1 },
    }) as RawPage;
    const page = this.normalize(raw);
    await this.uploadImages(id, spec.images);
    return page;
  }
}
