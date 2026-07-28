import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import type {
  Capability, Issue, IssueCreate, IssueLink, IssuePatch, IssueState, LinkType,
  Milestone, Phase, Tracker,
} from "../types.js";
import { milestonesUnsupported } from "../unsupported.js";

const API = "https://api.linear.app/graphql";
const LIST_CAP = 100;

export const configSchema = z.object({
  teamId: z.string().min(1),
  apiKeyEnv: z.string().default("LINEAR_API_KEY"),
});

export function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker {
  return new LinearTracker(config, fetchImpl);
}

// Every issue read goes through this one shape — queries share the fragment.
const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id identifier title description url updatedAt
  state { type }
  labels { nodes { name } }
  project { id }
  assignee { displayName }
}`;

interface LinearIssueNode {
  id: string; identifier: string; title: string; description: string | null;
  url: string; updatedAt: string;
  state: { type: string };
  labels: { nodes: Array<{ name: string }> };
  project: { id: string } | null;
  assignee: { displayName: string } | null;
}

interface LinearStateNode { id: string; name: string; type: string; position: number }

interface LinearProjectNode { id: string; name: string; state: string }

export class LinearTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
    hasMilestones: false, hasPhaseClose: true, hasComments: true, hasWorklog: false,
  };

  // Lazy per-instance caches — a team's workflow states and label ids are
  // stable for the life of a server process; one query each, then reuse.
  private statesCache: LinearStateNode[] | undefined;
  private labelCache = new Map<string, string>();

  constructor(
    private readonly cfg: { teamId: string; apiKeyEnv: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly keyProvider: () => string = () => resolveLinearKey(cfg.apiKeyEnv),
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown>, context: string): Promise<T> {
    const raw = await fetchJson(this.fetchImpl, API, {
      method: "POST",
      // Linear personal API keys go in raw — Bearer prefix is OAuth-only.
      headers: { authorization: this.keyProvider(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, { context: `linear ${context}` });
    const { data, errors } = raw as {
      data?: T; errors?: Array<{ message: string }>;
    };
    if (errors?.length) {
      const msg = errors[0].message;
      if (/not found|could not find/i.test(msg)) {
        throw new CairnError("NOT_FOUND", `linear ${context}: ${msg}`);
      }
      throw new CairnError("TRACKER_DOWN", `linear ${context}: ${msg}`);
    }
    return data as T;
  }

  private normalize(raw: LinearIssueNode): Issue {
    const type = raw.state.type;
    const state: IssueState =
      type === "completed" || type === "canceled" ? "closed"
        : type === "started" ? "in_progress" : "open";
    return {
      id: raw.identifier, title: raw.title, body: raw.description ?? "",
      state,
      labels: raw.labels.nodes.map((l) => l.name),
      phase: raw.project?.id,
      assignee: raw.assignee?.displayName,
      updatedAt: raw.updatedAt,
      url: raw.url,
    };
  }

  /** Team workflow states, fetched once. */
  private async states(): Promise<LinearStateNode[]> {
    if (!this.statesCache) {
      const data = await this.gql<{ team: { states: { nodes: LinearStateNode[] } } }>(
        `query States($teamId: String!) { team(id: $teamId) { states { nodes { id name type position } } } }`,
        { teamId: this.cfg.teamId }, "states");
      this.statesCache = data.team.states.nodes;
    }
    return this.statesCache;
  }

  /** SPI state → the team's canonical stateId for that bucket. */
  private async stateId(state: IssueState): Promise<string> {
    const all = await this.states();
    const byType = (t: string) =>
      all.filter((s) => s.type === t).sort((a, b) => a.position - b.position)[0];
    const hit = state === "closed" ? byType("completed")
      : state === "in_progress" ? byType("started")
        : byType("unstarted") ?? byType("backlog");
    if (!hit) {
      throw new CairnError("CONFIG_INVALID",
        `linear team ${this.cfg.teamId} has no workflow state for '${state}'`,
        "check the team's workflow configuration in Linear");
    }
    return hit.id;
  }

  /** Label names → ids, find-or-create against the team. */
  private async labelIds(names: string[]): Promise<string[]> {
    const missing = names.filter((n) => !this.labelCache.has(n));
    if (missing.length) {
      const data = await this.gql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
        `query Labels($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }`,
        { teamId: this.cfg.teamId }, "labels");
      for (const l of data.team.labels.nodes) this.labelCache.set(l.name, l.id);
      for (const name of names.filter((n) => !this.labelCache.has(n))) {
        const created = await this.gql<{ issueLabelCreate: { issueLabel: { id: string; name: string } } }>(
          `mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }`,
          { input: { name, teamId: this.cfg.teamId } }, "label_create");
        this.labelCache.set(created.issueLabelCreate.issueLabel.name, created.issueLabelCreate.issueLabel.id);
      }
    }
    return names.map((n) => this.labelCache.get(n)!);
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const gqlInput: Record<string, unknown> = {
      teamId: this.cfg.teamId, title: input.title, description: input.body ?? "",
    };
    if (input.labels?.length) gqlInput.labelIds = await this.labelIds(input.labels);
    if (input.phase) gqlInput.projectId = input.phase;
    const data = await this.gql<{ issueCreate: { issue: LinearIssueNode } }>(
      `${ISSUE_FIELDS} mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ...IssueFields } } }`,
      { input: gqlInput }, "issue_create");
    return this.normalize(data.issueCreate.issue);
  }

  async getIssue(id: string): Promise<Issue> {
    const data = await this.gql<{ issue: LinearIssueNode }>(
      `${ISSUE_FIELDS} query Issue($id: String!) { issue(id: $id) { ...IssueFields } }`,
      { id }, "issue_get");
    return this.normalize(data.issue);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    const input: Record<string, unknown> = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.body !== undefined) input.description = patch.body;
    if (patch.state !== undefined) input.stateId = await this.stateId(patch.state);
    if (patch.labels !== undefined) input.labelIds = await this.labelIds(patch.labels);
    const data = await this.gql<{ issueUpdate: { issue: LinearIssueNode } }>(
      `${ISSUE_FIELDS} mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ...IssueFields } } }`,
      { id, input }, "issue_update");
    return this.normalize(data.issueUpdate.issue);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const gqlFilter: Record<string, unknown> = { team: { id: { eq: this.cfg.teamId } } };
    if (filter?.phase) gqlFilter.project = { id: { eq: filter.phase } };
    const data = await this.gql<{ issues: { nodes: LinearIssueNode[] } }>(
      `${ISSUE_FIELDS} query Issues($filter: IssueFilter, $first: Int!) { issues(filter: $filter, first: $first) { nodes { ...IssueFields } } }`,
      { filter: gqlFilter, first: LIST_CAP }, "issue_list");
    if (data.issues.nodes.length === LIST_CAP) {
      console.error(`[cairn] linear issue_list truncated at ${LIST_CAP} items for team ${this.cfg.teamId}`);
    }
    let issues = data.issues.nodes.map((n) => this.normalize(n));
    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
    return issues;
  }

  // A cairn phase is a Linear Project — named container, native close state.
  private normalizePhase(raw: LinearProjectNode): Phase {
    return {
      id: raw.id, name: raw.name,
      state: raw.state === "completed" || raw.state === "canceled" ? "closed" : "open",
    };
  }

  async createPhase(name: string): Promise<Phase> {
    const data = await this.gql<{ projectCreate: { project: LinearProjectNode } }>(
      `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id name state } } }`,
      { input: { name, teamIds: [this.cfg.teamId] } }, "phase_create");
    return this.normalizePhase(data.projectCreate.project);
  }

  async listPhases(): Promise<Phase[]> {
    const data = await this.gql<{ team: { projects: { nodes: LinearProjectNode[] } } }>(
      `query Projects($teamId: String!) { team(id: $teamId) { projects { nodes { id name state } } } }`,
      { teamId: this.cfg.teamId }, "phase_list");
    return data.team.projects.nodes.map((p) => this.normalizePhase(p));
  }

  /** Org project statuses, fetched once — close writes the 'completed' one. */
  private completedStatusCache: string | undefined;
  private async completedStatusId(): Promise<string> {
    if (!this.completedStatusCache) {
      const data = await this.gql<{ organization: { projectStatuses: { nodes: Array<{ id: string; type: string }> } } }>(
        `query ProjectStatuses { organization { projectStatuses { nodes { id type } } } }`,
        {}, "project_statuses");
      const hit = data.organization.projectStatuses.nodes.find((s) => s.type === "completed");
      if (!hit) {
        throw new CairnError("CONFIG_INVALID",
          "linear organization has no 'completed' project status",
          "check project statuses in Linear workspace settings");
      }
      this.completedStatusCache = hit.id;
    }
    return this.completedStatusCache;
  }

  async closePhase(id: string): Promise<Phase> {
    const statusId = await this.completedStatusId();
    const data = await this.gql<{ projectUpdate: { project: LinearProjectNode } }>(
      `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { project { id name state } } }`,
      { id, input: { statusId } }, "phase_close");
    return this.normalizePhase(data.projectUpdate.project);
  }

  async createMilestone(_name: string): Promise<Milestone> { return milestonesUnsupported("linear"); }
  async listMilestones(): Promise<Milestone[]> { return milestonesUnsupported("linear"); }
  async completeMilestone(_id: string): Promise<Milestone> { return milestonesUnsupported("linear"); }

  /** Identifier (ENG-123) → internal UUID; free NOT_FOUND on missing issues. */
  private async uuid(id: string): Promise<string> {
    const data = await this.gql<{ issue: { id: string } }>(
      `query IssueId($id: String!) { issue(id: $id) { id } }`, { id }, "issue_resolve");
    return data.issue.id;
  }

  async commentIssue(id: string, text: string): Promise<{ id: string; url?: string }> {
    const issueId = await this.uuid(id);
    const data = await this.gql<{ commentCreate: { comment: { id: string; url?: string } } }>(
      `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id url } } }`,
      { input: { issueId, body: text } }, "issue_comment");
    return { id: data.commentCreate.comment.id, url: data.commentCreate.comment.url };
  }
}

export function resolveLinearKey(apiKeyEnv: string): string {
  const env = process.env[apiKeyEnv];
  if (env) return env;
  throw new CairnError("AUTH_MISSING", `no Linear credentials (${apiKeyEnv})`,
    `export ${apiKeyEnv} (create a personal API key at linear.app/settings/api)`);
}
