import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker,
} from "../types.js";

const API = "https://api.clickup.com/api/v2";
const LIST_CAP = 100;

export const configSchema = z.object({
  defaultListId: z.string().min(1), // un-phased tasks land here
  folderId: z.string().optional(), // phases become Lists in this folder…
  spaceId: z.string().optional(), // …or directly in this space (exactly one required)
  tokenEnv: z.string().default("CLICKUP_TOKEN"),
  statuses: z.object({
    open: z.string().default("to do"),
    in_progress: z.string(),
    closed: z.string(),
  }).default({ open: "to do", in_progress: "in progress", closed: "complete" }),
}).refine((c) => Boolean(c.folderId) !== Boolean(c.spaceId), {
  message: "exactly one of folderId or spaceId is required",
});

export type ClickUpConfig = z.infer<typeof configSchema>;

export function make(config: ClickUpConfig, fetchImpl?: FetchLike): Tracker {
  return new ClickUpTracker(config, fetchImpl);
}

export function resolveClickUpToken(tokenEnv: string): string {
  const env = process.env[tokenEnv];
  if (env) return env;
  throw new CairnError("AUTH_MISSING", `no ClickUp credentials (${tokenEnv} not set)`,
    `export ${tokenEnv}`);
}

interface CuStatus {
  status: string;
  type: string; // "open" | "custom" | "done" | "closed"
}

interface CuTask {
  id: string;
  name: string;
  description: string | null;
  status: CuStatus;
  tags: Array<{ name: string }>;
  list: { id: string };
  assignees: Array<{ username?: string; email?: string }>;
  date_updated: string; // unix-ms string
  url: string;
}

export class ClickUpTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
  };

  constructor(
    private readonly cfg: ClickUpConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly tokenProvider: () => string = () => resolveClickUpToken(cfg.tokenEnv),
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: this.tokenProvider(),
      "content-type": "application/json",
    };
  }

  private async api(method: string, path: string, body?: unknown, context = "clickup"): Promise<unknown> {
    return fetchJson(this.fetchImpl, `${API}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { context });
  }

  private assertId(id: string): void {
    if (!/^[a-z0-9]+$/i.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid task id: ${id}`,
        "task id must be alphanumeric");
    }
  }

  /** Validates a caller-supplied phase (list) id before it reaches a URL. defaultListId is trusted config, not user input. */
  private assertPhaseId(id: string): void {
    if (!/^[a-z0-9]+$/i.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid phase id: ${id}`,
        "phase id must be alphanumeric");
    }
  }

  private normalizeState(status: CuStatus): IssueState {
    if (status.type === "open") return "open";
    if (status.type === "done" || status.type === "closed") return "closed";
    // custom: compare to the configured in_progress status name, case-insensitively
    return status.status.toLowerCase() === this.cfg.statuses.in_progress.toLowerCase()
      ? "in_progress"
      : "open";
  }

  private normalize(raw: CuTask): Issue {
    return {
      id: raw.id,
      title: raw.name,
      body: raw.description ?? "",
      state: this.normalizeState(raw.status),
      labels: raw.tags.map((t) => t.name),
      phase: raw.list?.id,
      assignee: raw.assignees[0]?.username ?? raw.assignees[0]?.email,
      updatedAt: new Date(Number(raw.date_updated)).toISOString(),
      url: raw.url,
    };
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    if (input.phase) this.assertPhaseId(input.phase);
    const listId = input.phase ?? this.cfg.defaultListId;
    const body: Record<string, unknown> = {
      name: input.title, description: input.body ?? "",
    };
    const raw = (await this.api("POST", `/list/${listId}/task`, body,
      "clickup createIssue")) as CuTask;
    const issue = this.normalize(raw);
    if (input.labels?.length) return this.reconcileTags(issue.id, [], input.labels, issue);
    return issue;
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = (await this.api("GET", `/task/${id}`, undefined, "clickup getIssue")) as CuTask;
    return this.normalize(raw);
  }

  /** Adds/removes tags to match `desired`, given the tags currently on the task (by name). */
  private async reconcileTags(id: string, current: string[], desired: string[], base: Issue): Promise<Issue> {
    const toAdd = desired.filter((l) => !current.includes(l));
    const toRemove = current.filter((l) => !desired.includes(l));
    for (const label of toRemove) {
      await this.api("DELETE", `/task/${id}/tag/${encodeURIComponent(label)}`, undefined, "clickup removeTag");
    }
    for (const label of toAdd) {
      await this.api("POST", `/task/${id}/tag/${encodeURIComponent(label)}`, undefined, "clickup addTag");
    }
    if (toAdd.length === 0 && toRemove.length === 0) return base;
    return { ...base, labels: desired };
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.name = patch.title;
    if (patch.body !== undefined) body.description = patch.body;
    // assignee writes need numeric user-id resolution — deferred until assignee semantics are speced
    if (patch.state === "closed") body.status = this.cfg.statuses.closed;
    if (patch.state === "open") body.status = this.cfg.statuses.open;
    if (patch.state === "in_progress") body.status = this.cfg.statuses.in_progress;

    const raw = (Object.keys(body).length > 0
      ? await this.api("PUT", `/task/${id}`, body, "clickup updateIssue")
      : await this.api("GET", `/task/${id}`, undefined, "clickup getIssue")) as CuTask;
    let issue = this.normalize(raw);

    if (patch.labels !== undefined) {
      issue = await this.reconcileTags(id, issue.labels, patch.labels, issue);
    }
    return issue;
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    // v1: unfiltered listIssues() covers only the default list — ClickUp has
    // no "all tasks across lists" endpoint without iterating every list, so
    // an unphased call is scoped to defaultListId just like a phased call is
    // scoped to that phase's list.
    if (filter?.phase) this.assertPhaseId(filter.phase);
    const listId = filter?.phase ?? this.cfg.defaultListId;
    const raw = (await this.api("GET", `/list/${listId}/task?include_closed=true`,
      undefined, "clickup listIssues")) as { tasks: CuTask[] };
    const tasks = raw.tasks ?? [];
    if (tasks.length >= LIST_CAP) {
      console.error(`[cairn] clickup listIssues truncated at ${LIST_CAP} items for list ${listId}`);
    }
    let issues = tasks.slice(0, LIST_CAP).map((t) => this.normalize(t));
    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const parentPath = this.cfg.folderId
      ? `/folder/${this.cfg.folderId}/list`
      : `/space/${this.cfg.spaceId}/list`;
    const raw = (await this.api("POST", parentPath, { name }, "clickup createPhase")) as
      { id: string; name: string };
    return { id: raw.id, name: raw.name, state: "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const parentPath = this.cfg.folderId
      ? `/folder/${this.cfg.folderId}/lists`
      : `/space/${this.cfg.spaceId}/lists`;
    const raw = (await this.api("GET", parentPath, undefined, "clickup listPhases")) as
      { lists: Array<{ id: string; name: string }> };
    return (raw.lists ?? []).map((l) => ({ id: l.id, name: l.name, state: "open" as const }));
  }
}
