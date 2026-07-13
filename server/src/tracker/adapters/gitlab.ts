import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginate, type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "../types.js";

const WIP = "in-progress";

interface GlIssue {
  iid: number; title: string; description: string | null; state: string;
  labels: string[]; milestone: { id: number } | null;
  assignee: { username: string } | null; updated_at: string; web_url: string;
}

interface GlMilestone {
  id: number; title: string; state: string;
}

export class GitLabTracker implements Tracker {
  readonly capabilities: Capability = { hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true };
  constructor(private cfg: z.infer<typeof configSchema>, private fetchImpl: FetchLike = fetch) {}

  private token(): string {
    const t = process.env[this.cfg.tokenEnv] ?? "";
    if (!t) throw new CairnError("AUTH_MISSING", `missing env ${this.cfg.tokenEnv}`, `export ${this.cfg.tokenEnv}=<gitlab token with api scope>`);
    return t;
  }
  private base(): string { return `${this.cfg.baseUrl.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(this.cfg.project)}`; }
  private headers(): Record<string, string> { return { "PRIVATE-TOKEN": this.token(), "content-type": "application/json" }; }
  private api(method: string, path: string, body?: unknown, op = "api"): Promise<unknown> {
    return fetchJson(this.fetchImpl, `${this.base()}${path}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body) }, { context: `gitlab ${op}` });
  }
  private assertId(id: string): void {
    if (!/^\d+$/.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid issue id: ${id}`, "issue id must be a numeric string");
    }
  }
  private normalize(raw: GlIssue): Issue {
    let state: IssueState = raw.state === "closed" ? "closed" : "open";
    if (state === "open" && raw.labels.includes(WIP)) state = "in_progress";
    return { id: String(raw.iid), title: raw.title, body: raw.description ?? "", state,
      labels: raw.labels.filter((l) => l !== WIP),
      phase: raw.milestone ? String(raw.milestone.id) : undefined,
      assignee: raw.assignee?.username, updatedAt: raw.updated_at, url: raw.web_url };
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    if (input.phase && !/^\d+$/.test(input.phase)) {
      throw new CairnError("CONFIG_INVALID", `invalid phase: ${input.phase}`, "phase must be a numeric string");
    }
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.body ?? "",
      labels: (input.labels ?? []).join(","),
    };
    if (input.phase) body.milestone_id = Number(input.phase);
    const raw = await this.api("POST", "/issues", body, "issue_create");
    return this.normalize(raw as GlIssue);
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api("GET", `/issues/${id}`, undefined, "issue_get");
    return this.normalize(raw as GlIssue);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.description = patch.body;

    if (patch.labels !== undefined) {
      body.labels = patch.labels.filter((l) => l !== WIP).join(",");
    }

    if (patch.state === "closed") {
      body.state_event = "close";
    } else if (patch.state === "open") {
      const current = patch.labels
        ? patch.labels.filter((l) => l !== WIP)
        : (await this.getIssue(id)).labels;
      body.labels = current.join(",");
    } else if (patch.state === "in_progress") {
      const current = patch.labels ?? (await this.getIssue(id)).labels;
      body.labels = [...new Set([...current, WIP])].join(",");
    }

    const raw = await this.api("PUT", `/issues/${id}`, body, "issue_update");
    return this.normalize(raw as GlIssue);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const raw = (await paginate(
      this.fetchImpl, `${this.base()}/issues?per_page=100&state=all`,
      { method: "GET", headers: this.headers() },
      { context: "gitlab issue_list" },
    )) as GlIssue[];
    let issues = raw.map((r) => this.normalize(r));
    if (filter?.phase) issues = issues.filter((i) => i.phase === filter.phase);
    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const raw = (await this.api("POST", "/milestones", { title: name }, "phase_create")) as GlMilestone;
    return { id: String(raw.id), name: raw.title, state: raw.state === "closed" ? "closed" : "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = (await paginate(
      this.fetchImpl, `${this.base()}/milestones?state=all&per_page=100`,
      { method: "GET", headers: this.headers() },
      { context: "gitlab phase_list" },
    )) as GlMilestone[];
    return raw.map((m) => ({ id: String(m.id), name: m.title, state: m.state === "closed" ? "closed" : "open" }));
  }
}

export const configSchema = z.object({
  baseUrl: z.string().url().default("https://gitlab.com"),
  project: z.string().min(1),
  tokenEnv: z.string().default("GITLAB_TOKEN"),
  extraLabels: z.array(z.string()).default([]),
});
export function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker {
  return new GitLabTracker(config, fetchImpl);
}
