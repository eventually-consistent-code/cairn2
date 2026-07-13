import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker,
} from "../types.js";

const MAX_IDS = 100;

export const configSchema = z.object({
  orgUrl: z.string().url(), // https://dev.azure.com/org
  project: z.string().min(1),
  workItemType: z.string().default("Issue"),
  patEnv: z.string().default("AZURE_DEVOPS_PAT"),
  apiVersion: z.string().default("7.0"),
  states: z.object({
    in_progress: z.string(),
    closed: z.string(),
    open: z.string().default("To Do"),
  }).default({ in_progress: "Doing", closed: "Done", open: "To Do" }),
});

type Config = z.infer<typeof configSchema>;

export function make(config: Config, fetchImpl?: FetchLike): Tracker {
  return new AzureBoardsTracker(config, fetchImpl);
}

export function resolveAzurePat(patEnv: string): string {
  const env = process.env[patEnv];
  if (env) return env;
  throw new CairnError("AUTH_MISSING", `no Azure DevOps PAT (env var ${patEnv})`,
    `export ${patEnv} with a PAT that has Work Items (Read & Write) scope`);
}

interface WorkItemFields {
  "System.Title"?: string;
  "System.Description"?: string;
  "System.State"?: string;
  "System.StateCategory"?: string;
  "System.Tags"?: string;
  "System.IterationPath"?: string;
  "System.AssignedTo"?: { uniqueName?: string; displayName?: string } | string;
  "System.ChangedDate"?: string;
  [key: string]: unknown;
}

interface WorkItem {
  id: number;
  fields: WorkItemFields;
  url?: string;
}

interface IterationNode {
  identifier: string;
  name: string;
  path?: string;
  children?: IterationNode[];
}

export class AzureBoardsTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
  };

  /** id (GUID) -> full iteration path, refreshed from listPhases() when an unknown id shows up. */
  private phasePaths = new Map<string, string>();

  /** Tracks whether we've called listPhases() once on this instance (guards against infinite refresh loops). */
  private phasesLoaded = false;

  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly tokenProvider: () => string = () => resolveAzurePat(cfg.patEnv),
  ) {}

  private headers(contentType = "application/json"): Record<string, string> {
    const pat = this.tokenProvider();
    return {
      authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
      accept: "application/json",
      "content-type": contentType,
    };
  }

  private url(path: string, extraParams?: Record<string, string>): string {
    const base = this.cfg.orgUrl.replace(/\/$/, "");
    const u = new URL(`${base}${path}`);
    u.searchParams.set("api-version", this.cfg.apiVersion);
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  private async api(
    method: string, path: string, body?: unknown,
    opts: { contentType?: string; params?: Record<string, string>; context?: string } = {},
  ): Promise<unknown> {
    return fetchJson(this.fetchImpl, this.url(path, opts.params), {
      method,
      headers: this.headers(opts.contentType ?? "application/json"),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { context: opts.context ?? "azure-boards" });
  }

  private assertId(id: string): void {
    if (!/^\d+$/.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid work item id: ${id}`,
        "work item id must be a numeric string");
    }
  }

  private get projectPath(): string {
    return encodeURIComponent(this.cfg.project);
  }

  private normalizeState(fields: WorkItemFields): IssueState {
    const category = fields["System.StateCategory"];
    if (category) {
      const c = category.toLowerCase();
      if (c === "completed" || c === "removed") return "closed";
      if (c === "inprogress" || c === "resolved") return "in_progress";
      if (c === "proposed") return "open";
    }
    const state = fields["System.State"];
    const { states } = this.cfg;
    if (state === states.closed) return "closed";
    if (state === states.in_progress) return "in_progress";
    return "open";
  }

  private normalize(raw: WorkItem): Issue {
    const f = raw.fields;
    const tags = f["System.Tags"];
    const labels = tags ? tags.split("; ").filter(Boolean) : [];
    const assignedTo = f["System.AssignedTo"];
    const assignee = typeof assignedTo === "string"
      ? assignedTo
      : assignedTo?.uniqueName ?? assignedTo?.displayName;
    const iterationPath = f["System.IterationPath"];
    let phase: string | undefined;
    if (iterationPath) {
      for (const [id, path] of this.phasePaths) {
        if (path === iterationPath) { phase = id; break; }
      }
    }
    return {
      id: String(raw.id),
      title: f["System.Title"] ?? "",
      body: f["System.Description"] ?? "",
      state: this.normalizeState(f),
      labels,
      phase,
      assignee,
      updatedAt: f["System.ChangedDate"] ?? new Date(0).toISOString(),
      url: raw.url ?? this.url(`/${this.projectPath}/_apis/wit/workitems/${raw.id}`),
    };
  }

  /** Escapes single quotes in a WIQL string literal by doubling them. */
  private escapeWiql(s: string): string {
    return s.replace(/'/g, "''");
  }

  /**
   * Normalizes a classificationnodes iteration path to the System.IterationPath
   * format: strips a leading backslash and the literal "Iteration\" segment
   * classificationnodes includes but System.IterationPath doesn't, e.g.
   * `\Proj\Iteration\Sprint 1` -> `Proj\Sprint 1`.
   */
  private normalizeIterationPath(path: string): string {
    return path.replace(/^\\/, "").replace(/^([^\\]+)\\Iteration\\/, "$1\\");
  }

  /** Flattens a classificationnodes response into a flat list of leaf-ish iteration nodes, tolerating both response shapes. */
  private flattenIterationNodes(raw: { value: IterationNode[] } | IterationNode): IterationNode[] {
    if ("value" in raw && Array.isArray(raw.value)) return raw.value;
    return (raw as IterationNode).children ?? [];
  }

  /** Resolves a phase id (GUID) to its iteration path, refreshing the map from listPhases() if unknown. */
  private async resolvePhasePath(phaseId: string): Promise<string> {
    if (!this.phasePaths.has(phaseId)) await this.listPhases();
    const path = this.phasePaths.get(phaseId);
    if (!path) {
      throw new CairnError("NOT_FOUND", `unknown phase id: ${phaseId}`,
        "create the phase first via createPhase(), or check the phase id");
    }
    return path;
  }

  /** Resolves an iteration path to a phase id (GUID), self-healing the map on miss if not yet loaded. */
  private async phaseIdForPath(iterationPath: string | undefined): Promise<string | undefined> {
    if (!iterationPath) return undefined;

    // Scan map for a match.
    for (const [id, path] of this.phasePaths) {
      if (path === iterationPath) return id;
    }

    // Miss: if map not yet refreshed this instance, call listPhases() once and rescan.
    if (!this.phasesLoaded) {
      await this.listPhases();
      for (const [id, path] of this.phasePaths) {
        if (path === iterationPath) return id;
      }
    }

    // Still missing after refresh (or map already loaded and no match): give up.
    return undefined;
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const ops: Array<{ op: string; path: string; value: unknown }> = [
      { op: "add", path: "/fields/System.Title", value: input.title },
      { op: "add", path: "/fields/System.Description", value: input.body ?? "" },
    ];
    if (input.labels?.length) {
      ops.push({ op: "add", path: "/fields/System.Tags", value: input.labels.join("; ") });
    }
    if (input.phase) {
      const path = await this.resolvePhasePath(input.phase);
      ops.push({ op: "add", path: "/fields/System.IterationPath", value: path });
    }
    const wtype = encodeURIComponent(`$${this.cfg.workItemType}`);
    const raw = await this.api(
      "POST", `/${this.projectPath}/_apis/wit/workitems/${wtype}`, ops,
      { contentType: "application/json-patch+json", context: "azure-boards issue_create" },
    );
    return this.normalize(raw as WorkItem);
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api(
      "GET", `/${this.projectPath}/_apis/wit/workitems/${id}`, undefined,
      { context: "azure-boards issue_get" },
    );
    const workItem = raw as WorkItem;
    const issue = this.normalize(workItem);
    if (issue.phase === undefined && workItem.fields["System.IterationPath"]) {
      issue.phase = await this.phaseIdForPath(workItem.fields["System.IterationPath"]);
    }
    return issue;
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const ops: Array<{ op: string; path: string; value: unknown }> = [];
    if (patch.title !== undefined) ops.push({ op: "add", path: "/fields/System.Title", value: patch.title });
    if (patch.body !== undefined) ops.push({ op: "add", path: "/fields/System.Description", value: patch.body });
    if (patch.labels !== undefined) ops.push({ op: "add", path: "/fields/System.Tags", value: patch.labels.join("; ") });
    if (patch.assignee !== undefined) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: patch.assignee });
    if (patch.state) {
      const { states } = this.cfg;
      const stateValue = patch.state === "closed" ? states.closed
        : patch.state === "in_progress" ? states.in_progress
        : states.open;
      ops.push({ op: "add", path: "/fields/System.State", value: stateValue });
    }
    const raw = await this.api(
      "PATCH", `/${this.projectPath}/_apis/wit/workitems/${id}`, ops,
      { contentType: "application/json-patch+json", context: "azure-boards issue_update" },
    );
    const workItem = raw as WorkItem;
    const issue = this.normalize(workItem);
    if (issue.phase === undefined && workItem.fields["System.IterationPath"]) {
      issue.phase = await this.phaseIdForPath(workItem.fields["System.IterationPath"]);
    }
    return issue;
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    let query = "SELECT [System.Id] FROM WorkItems";
    const projectClause = `[System.TeamProject] = '${this.escapeWiql(this.cfg.project)}'`;
    if (filter?.phase) {
      const path = await this.resolvePhasePath(filter.phase);
      query += ` WHERE ${projectClause} AND [System.IterationPath] = '${this.escapeWiql(path)}'`;
    } else {
      query += ` WHERE ${projectClause}`;
    }
    const wiqlRaw = await this.api(
      "POST", `/${this.projectPath}/_apis/wit/wiql`, { query },
      { context: "azure-boards issue_list_wiql" },
    ) as { workItems: Array<{ id: number }> };

    let ids = wiqlRaw.workItems.map((w) => w.id);
    if (ids.length > MAX_IDS) {
      console.error(`[cairn] azure-boards listIssues truncated at ${MAX_IDS} ids (WIQL returned ${ids.length})`);
      ids = ids.slice(0, MAX_IDS);
    }
    if (ids.length === 0) return [];

    const batchRaw = await this.api(
      "GET", `/${this.projectPath}/_apis/wit/workitems`, undefined,
      { params: { ids: ids.join(","), "$expand": "all" }, context: "azure-boards issue_list_batch" },
    ) as { value: WorkItem[] };

    const workItems = batchRaw.value;
    let issues = workItems.map((w) => this.normalize(w));

    // Self-heal phase resolution for all issues at once (one listPhases call per 100+ items)
    const unresolved = issues.filter((i) => i.phase === undefined && workItems.find((w) => w.id === Number(i.id))?.fields["System.IterationPath"]);
    if (unresolved.length > 0) {
      for (const issue of unresolved) {
        const raw = workItems.find((w) => w.id === Number(issue.id))!;
        issue.phase = await this.phaseIdForPath(raw.fields["System.IterationPath"]);
      }
    }

    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const raw = await this.api(
      "POST", `/${this.projectPath}/_apis/wit/classificationnodes/iterations`, { name },
      { context: "azure-boards phase_create" },
    ) as IterationNode;
    const path = raw.path ?? `${this.cfg.project}\\${raw.name}`;
    this.phasePaths.set(raw.identifier, path);
    return { id: raw.identifier, name: raw.name, state: "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = await this.api(
      "GET", `/${this.projectPath}/_apis/wit/classificationnodes/iterations`, undefined,
      { params: { "$depth": "2" }, context: "azure-boards phase_list" },
    ) as { value: IterationNode[] } | IterationNode;

    // Tolerate both known live-response shapes: a { value: [...] } wrapper, or
    // the root classification node itself with a `children` array (no `value`).
    const nodes = this.flattenIterationNodes(raw);

    this.phasePaths.clear();
    for (const node of nodes) {
      const path = node.path ? this.normalizeIterationPath(node.path) : `${this.cfg.project}\\${node.name}`;
      this.phasePaths.set(node.identifier, path);
    }
    this.phasesLoaded = true; // mark map as refreshed for this instance
    return nodes.map((node) => ({ id: node.identifier, name: node.name, state: "open" }));
  }
}
