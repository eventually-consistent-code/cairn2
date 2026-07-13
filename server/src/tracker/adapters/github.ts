import { execFileSync } from "node:child_process";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker,
} from "../types.js";

const API = "https://api.github.com";
const WIP_LABEL = "in-progress";

export function resolveGithubToken(): string {
  const env = process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new CairnError("AUTH_MISSING", "no GitHub credentials",
      "export GITHUB_TOKEN or run: gh auth login");
  }
}

interface GhIssue {
  number: number; title: string; body: string | null; state: string;
  labels: Array<{ name: string }>; milestone: { number: number } | null;
  assignee: { login: string } | null; updated_at: string; html_url: string;
  pull_request?: unknown;
}

export class GitHubTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, // via label convention
    hasPhases: true, hasDependencies: false, hasLabels: true,
  };

  constructor(
    private readonly cfg: { repo: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly tokenProvider: () => string = resolveGithubToken,
  ) {}

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    return fetchJson(this.fetchImpl, `${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.tokenProvider()}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private assertId(id: string): void {
    if (!/^\d+$/.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid issue id: ${id}`,
        "issue id must be a numeric string");
    }
  }

  private normalize(raw: GhIssue): Issue {
    const labels = raw.labels.map((l) => l.name);
    let state: IssueState = raw.state === "closed" ? "closed" : "open";
    if (state === "open" && labels.includes(WIP_LABEL)) state = "in_progress";
    return {
      id: String(raw.number), title: raw.title, body: raw.body ?? "",
      state, labels: labels.filter((l) => l !== WIP_LABEL),
      phase: raw.milestone ? String(raw.milestone.number) : undefined,
      assignee: raw.assignee?.login,
      updatedAt: raw.updated_at, url: raw.html_url,
    };
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    if (input.phase && !/^\d+$/.test(input.phase)) {
      throw new CairnError("CONFIG_INVALID",
        `invalid phase: ${input.phase}`,
        "phase must be a numeric string");
    }
    const body: Record<string, unknown> = {
      title: input.title, body: input.body ?? "", labels: input.labels ?? [],
    };
    if (input.phase) body.milestone = Number(input.phase);
    const raw = await this.api("POST", `/repos/${this.cfg.repo}/issues`, body);
    return this.normalize(raw as GhIssue);
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api("GET", `/repos/${this.cfg.repo}/issues/${id}`);
    return this.normalize(raw as GhIssue);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.labels !== undefined) body.labels = patch.labels;
    if (patch.assignee !== undefined) body.assignees = [patch.assignee];
    if (patch.state === "closed") body.state = "closed";
    if (patch.state === "open") {
      const current = patch.labels
        ? patch.labels.filter((l) => l !== WIP_LABEL)
        : (await this.getIssue(id)).labels;
      body.state = "open";
      body.labels = current;
    }
    if (patch.state === "in_progress") {
      const current = patch.labels ?? (await this.getIssue(id)).labels;
      body.state = "open";
      body.labels = [...new Set([...current, WIP_LABEL])];
    }
    const raw = await this.api("PATCH", `/repos/${this.cfg.repo}/issues/${id}`, body);
    return this.normalize(raw as GhIssue);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const params = new URLSearchParams({ state: "all", per_page: "100" });
    if (filter?.phase) params.set("milestone", filter.phase);
    const raw = (await this.api(
      "GET", `/repos/${this.cfg.repo}/issues?${params}`)) as GhIssue[];
    let issues = raw.filter((r) => !("pull_request" in r)).map((r) => this.normalize(r));
    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const raw = (await this.api("POST", `/repos/${this.cfg.repo}/milestones`,
      { title: name })) as { number: number; title: string; state: string };
    return { id: String(raw.number), name: raw.title,
      state: raw.state === "closed" ? "closed" : "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = (await this.api(
      "GET", `/repos/${this.cfg.repo}/milestones?state=all`)) as
      Array<{ number: number; title: string; state: string }>;
    return raw.map((m) => ({ id: String(m.number), name: m.title,
      state: m.state === "closed" ? "closed" : "open" }));
  }
}
