import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import { runProbe } from "../probe.js";
import type {
  Capability, Issue, IssueCreate, IssueEstimate, IssuePatch, IssueState, Milestone,
  Phase, ProbeResult, StateCategory, Tracker,
} from "../types.js";
import { matchesState } from "../types.js";

// Issue keys look like PROJ-123 (letters + digits, dash, digits).
const ID_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
const MAX_RESULTS = 100;

const STATUS_CATEGORY_MAP: Record<string, StateCategory> = {
  new: "open", indeterminate: "in_progress", done: "closed",
};

export const configSchema = z.object({
  baseUrl: z.string().url(),
  projectKey: z.string().min(1),
  issueType: z.string().default("Task"),
  emailEnv: z.string().default("JIRA_EMAIL"),
  tokenEnv: z.string().default("JIRA_API_TOKEN"),
  // Arbitrary extra keys are custom cairn states ("review": "In Review") —
  // resolved through the same transition-by-name machinery (CRN-26).
  transitions: z.record(z.string())
    .default({ in_progress: "In Progress", closed: "Done" })
    .refine((t) => typeof t.in_progress === "string" && typeof t.closed === "string",
      "transitions must include in_progress and closed"),
  // Board auto-discovers from the project; set this only when the project
  // has several boards and the first one is the wrong one.
  boardId: z.number().int().positive().optional(),
});

type JiraConfig = z.infer<typeof configSchema>;

export function make(config: JiraConfig, fetchImpl?: FetchLike): Tracker {
  return new JiraTracker(config, fetchImpl);
}

export function resolveJiraAuth(cfg: JiraConfig): { email: string; token: string } {
  const email = process.env[cfg.emailEnv];
  const token = process.env[cfg.tokenEnv];
  if (!email || !token) {
    throw new CairnError("AUTH_MISSING", "no Jira credentials",
      `export ${cfg.emailEnv} and ${cfg.tokenEnv} (create a token at https://id.atlassian.com/manage-profile/security/api-tokens)`);
  }
  return { email, token };
}

interface AdfNode {
  type?: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
}

interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; statusCategory: { key: string } };
}

interface JiraIssueFields {
  summary: string;
  description?: AdfNode | null;
  status: { name?: string; statusCategory: { key: string } };
  updated: string;
  labels?: string[];
  parent?: { key: string };
  assignee?: { accountId?: string } | null;
  timetracking?: { originalEstimateSeconds?: number } | null;
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

/** Wraps plain text in the minimal Atlassian Document Format Jira expects on write. */
function adf(text: string): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: text || " " }] }],
  };
}

/** Recursively walks an ADF document, concatenating all text node contents. */
function adfToText(node: AdfNode | null | undefined): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(adfToText).join("");
}

/**
 * Jira emits timestamps like `2026-07-12T10:30:00.000+0000` — a numeric
 * offset with no colon, which breaks strict ISO-8601 parsers. Insert the
 * colon (same trick as 1.x gbsync.py's parse_ts) so it's valid ISO-8601.
 */
function normalizeTimestamp(raw: string): string {
  const s = raw.trim();
  if (s.length >= 5 && (s[s.length - 5] === "+" || s[s.length - 5] === "-") && s[s.length - 3] !== ":") {
    return `${s.slice(0, -2)}:${s.slice(-2)}`;
  }
  return s;
}

export class JiraTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
    hasMilestones: true, hasPhaseClose: true, hasComments: true, hasWorklog: true,
    hasEstimates: true,
    hasIssueAttachments: true,
  };

  // Story-point field id varies per site ("Story point estimate" on
  // team-managed projects, "Story Points" on company-managed) — discovered
  // once, `null` = site has none (points skipped with one warning).
  private storyPointField: string | null | undefined;

  private async storyPointFieldId(): Promise<string | null> {
    if (this.storyPointField === undefined) {
      const raw = (await this.api("GET", "/rest/api/3/field", undefined,
        "jira field_list")) as Array<{ id: string; name: string }>;
      const hit = raw.find((f) => /^story points?( estimate)?$/i.test(f.name));
      if (!hit) {
        console.error("[cairn] jira: no story-point field on this site — points estimates skipped");
      }
      this.storyPointField = hit?.id ?? null;
    }
    return this.storyPointField;
  }

  /** SPI estimate → Jira write fields (timetracking + discovered points field). */
  private async estimateFields(est: IssueEstimate): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (est.minutes !== undefined) out.timetracking = { originalEstimate: `${est.minutes}m` };
    if (est.points !== undefined) {
      const fld = await this.storyPointFieldId();
      if (fld) out[fld] = est.points;
    }
    return out;
  }

  /** Read-field list: timetracking always; the points field once discovered. */
  private readFields(): string[] {
    const base = ["summary", "description", "status", "updated", "labels",
      "parent", "assignee", "timetracking"];
    return this.storyPointField ? [...base, this.storyPointField] : base;
  }

  private projectId: number | undefined;

  constructor(
    private readonly cfg: JiraConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly authProvider: () => { email: string; token: string } = () => resolveJiraAuth(cfg),
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

  private async api(method: string, path: string, body?: unknown, context = "jira"): Promise<unknown> {
    return fetchJson(this.fetchImpl, `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { context });
  }

  private assertId(id: string): void {
    if (!ID_RE.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid issue id: ${id}`,
        "issue id must look like PROJ-123");
    }
  }

  private normalize(raw: JiraIssue): Issue {
    const f = raw.fields;
    const category = STATUS_CATEGORY_MAP[f.status?.statusCategory?.key ?? "new"] ?? "open";
    const state = f.status?.name ?? category;
    const seconds = f.timetracking?.originalEstimateSeconds;
    const points = this.storyPointField
      ? (f as unknown as Record<string, unknown>)[this.storyPointField] : undefined;
    const estimate: IssueEstimate | undefined =
      seconds !== undefined || typeof points === "number"
        ? {
          ...(typeof points === "number" ? { points } : {}),
          ...(seconds !== undefined ? { minutes: Math.round(seconds / 60) } : {}),
        }
        : undefined;
    return {
      estimate,
      id: raw.key,
      title: f.summary,
      body: f.description ? adfToText(f.description) : "",
      state,
      category,
      labels: f.labels ?? [],
      phase: f.parent?.key,
      assignee: f.assignee?.accountId ?? undefined,
      updatedAt: normalizeTimestamp(f.updated),
      url: `${this.cfg.baseUrl.replace(/\/$/, "")}/browse/${raw.key}`,
    };
  }

  /** GET transitions for `key`, find one whose `to.name` or transition `name` matches (case-insensitive), POST it. */
  private async transitionByName(key: string, targetName: string): Promise<void> {
    const resp = (await this.api("GET", `/rest/api/3/issue/${key}/transitions`,
      undefined, "jira transition_list")) as { transitions: JiraTransition[] };
    const target = targetName.toLowerCase();
    const match = resp.transitions.find(
      (t) => t.to?.name?.toLowerCase() === target || t.name?.toLowerCase() === target,
    );
    if (!match) {
      console.error(`[cairn] jira: no transition to "${targetName}" found for issue ${key}; leaving state unchanged`);
      return;
    }
    await this.api("POST", `/rest/api/3/issue/${key}/transitions`,
      { transition: { id: match.id } }, "jira transition");
  }

  /** in_progress -> open has no fixed target name; find any transition whose target category is 'new'. */
  private async transitionToOpenCategory(key: string): Promise<void> {
    const resp = (await this.api("GET", `/rest/api/3/issue/${key}/transitions`,
      undefined, "jira transition_list")) as { transitions: JiraTransition[] };
    const match = resp.transitions.find((t) => t.to?.statusCategory?.key === "new");
    if (!match) {
      console.error(`[cairn] jira: no transition to an "open"-category state found for issue ${key}; leaving state unchanged`);
      return;
    }
    await this.api("POST", `/rest/api/3/issue/${key}/transitions`,
      { transition: { id: match.id } }, "jira transition");
  }

  // Board + active sprint, each resolved once per instance. `null` is a real
  // answer ("no board" / "no active sprint"), `undefined` means not asked yet.
  private boardCache: { id: number; type: string } | null | undefined;
  private sprintCache: number | null | undefined;

  private async board(): Promise<{ id: number; type: string } | null> {
    if (this.boardCache === undefined) {
      if (this.cfg.boardId) {
        const raw = (await this.api("GET", `/rest/agile/1.0/board/${this.cfg.boardId}`,
          undefined, "jira board_get")) as { id: number; type: string };
        this.boardCache = { id: raw.id, type: raw.type };
      } else {
        const raw = (await this.api("GET",
          `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(this.cfg.projectKey)}`,
          undefined, "jira board_list")) as { values: Array<{ id: number; type: string }> };
        this.boardCache = raw.values[0] ?? null;
      }
    }
    return this.boardCache;
  }

  private async activeSprintId(): Promise<number | null> {
    const board = await this.board();
    if (!board || board.type !== "scrum") return null;
    if (this.sprintCache === undefined) {
      const raw = (await this.api("GET",
        `/rest/agile/1.0/board/${board.id}/sprint?state=active`,
        undefined, "jira sprint_list")) as { values: Array<{ id: number }> };
      this.sprintCache = raw.values[0]?.id ?? null;
    }
    return this.sprintCache;
  }

  /** Scrum boards: new work belongs in the running sprint. Best-effort —
   *  an Agile-API hiccup must never turn a successful create into a failure. */
  private async assignToActiveSprint(key: string): Promise<void> {
    try {
      const sprint = await this.activeSprintId();
      if (sprint === null) return;
      await this.api("POST", `/rest/agile/1.0/sprint/${sprint}/issue`,
        { issues: [key] }, "jira sprint_assign");
    } catch (e) {
      console.error(`[cairn] jira: sprint assignment for ${key} skipped: ${e}`);
    }
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const fields: Record<string, unknown> = {
      project: { key: this.cfg.projectKey },
      summary: input.title,
      description: adf(input.body ?? ""),
      issuetype: { name: this.cfg.issueType },
    };
    if (input.labels?.length) fields.labels = input.labels;
    if (input.phase) fields.parent = { key: input.phase };
    if (input.estimate) Object.assign(fields, await this.estimateFields(input.estimate));
    const created = (await this.api("POST", "/rest/api/3/issue", { fields },
      "jira issue_create")) as { key: string };
    await this.assignToActiveSprint(created.key);
    return this.getIssue(created.key);
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api("GET",
      `/rest/api/3/issue/${id}?fields=${this.readFields().join(",")}`,
      undefined, "jira issue_get");
    return this.normalize(raw as JiraIssue);
  }

  private self: string | undefined;

  async resolveSelf(): Promise<string | undefined> {
    if (this.self) return this.self;
    const me = await this.api("GET", "/rest/api/3/myself", undefined,
      "jira myself") as { accountId?: string };
    this.self = me.accountId;
    return this.self;
  }

  /** Preflight: /myself is the cheapest authenticated call this backend has —
   *  the same one resolveSelf already makes. */
  async probe(): Promise<ProbeResult> {
    return runProbe(() => this.resolveSelf());
  }

  /** Assignee values may arrive as an email (user.handle) — Jira wants accountId. */
  private async toAccountId(value: string): Promise<string> {
    if (!value.includes("@")) return value;
    const hits = await this.api("GET",
      `/rest/api/3/user/search?query=${encodeURIComponent(value)}`, undefined,
      "jira user_search") as Array<{ accountId?: string }>;
    const id = hits[0]?.accountId;
    if (!id) {
      throw new CairnError("NOT_FOUND", `no Jira user matches '${value}'`,
        "set user.handle in cairn.json to a Jira accountId or exact email");
    }
    return id;
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.body !== undefined) fields.description = adf(patch.body);
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (patch.assignee !== undefined) {
      fields.assignee = { accountId: await this.toAccountId(patch.assignee) };
    }
    if (patch.estimate) Object.assign(fields, await this.estimateFields(patch.estimate));
    if (Object.keys(fields).length > 0) {
      await this.api("PUT", `/rest/api/3/issue/${id}`, { fields }, "jira issue_update");
    }
    if (patch.state === "in_progress") {
      await this.transitionByName(id, this.cfg.transitions.in_progress!);
    } else if (patch.state === "closed") {
      await this.transitionByName(id, this.cfg.transitions.closed!);
    } else if (patch.state === "open") {
      await this.transitionToOpenCategory(id);
    } else if (patch.state !== undefined) {
      // Custom state: transitions-map alias first, else the literal name —
      // Jira's own transition list is the authority either way.
      await this.transitionByName(id, this.cfg.transitions[patch.state] ?? patch.state);
    }
    return this.getIssue(id);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    if (filter?.phase && !ID_RE.test(filter.phase)) {
      throw new CairnError("NOT_FOUND", `invalid phase key: ${filter.phase}`,
        "phase key must look like PROJ-123");
    }
    // Epics model cairn "phases", not issues — exclude them from the unfiltered
    // list. A parent-filtered query can't match an epic anyway (epics have no
    // parent), so no exclusion is needed on that branch.
    const jql = filter?.phase
      ? `parent = ${filter.phase}`
      : `project = ${this.cfg.projectKey} AND issuetype != Epic`;
    const raw = (await this.api("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: MAX_RESULTS,
      fields: this.readFields(),
    }, "jira issue_list")) as { issues: JiraIssue[]; total?: number };
    if (raw.issues.length === MAX_RESULTS) {
      console.error(`[cairn] jira issue_list truncated at ${MAX_RESULTS} results (total: ${raw.total ?? "unknown"})`);
    }
    let issues = raw.issues.map((i) => this.normalize(i));
    if (filter?.state) issues = issues.filter((i) => matchesState(i, filter.state!));
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const fields: Record<string, unknown> = {
      project: { key: this.cfg.projectKey },
      summary: name,
      issuetype: { name: "Epic" },
    };
    const created = (await this.api("POST", "/rest/api/3/issue", { fields },
      "jira phase_create")) as { key: string };
    return { id: created.key, name, state: "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = (await this.api("POST", "/rest/api/3/search/jql", {
      jql: `project = ${this.cfg.projectKey} AND issuetype = Epic`,
      maxResults: MAX_RESULTS,
      fields: ["summary", "status", "updated"],
    }, "jira phase_list")) as { issues: JiraIssue[]; total?: number };
    if (raw.issues.length === MAX_RESULTS) {
      console.error(`[cairn] jira phase_list truncated at ${MAX_RESULTS} results (total: ${raw.total ?? "unknown"})`);
    }
    return raw.issues.map((i) => ({
      id: i.key,
      name: i.fields.summary,
      state: STATUS_CATEGORY_MAP[i.fields.status?.statusCategory?.key ?? "new"] === "closed" ? "closed" : "open",
    }));
  }

  private async resolveProjectId(): Promise<number> {
    if (this.projectId === undefined) {
      const raw = (await this.api("GET",
        `/rest/api/3/project/${this.cfg.projectKey}`, undefined,
        "jira project_get")) as { id: string };
      this.projectId = Number(raw.id);
    }
    return this.projectId;
  }

  private normalizeVersion(raw: { id: string; name: string; released?: boolean }): Milestone {
    return {
      id: raw.id, name: raw.name,
      state: raw.released ? "released" : "open",
      url: `${this.cfg.baseUrl.replace(/\/$/, "")}/projects/${this.cfg.projectKey}/versions/${raw.id}`,
    };
  }

  async closePhase(id: string): Promise<Phase> {
    // Jira phases are Epics, and Epics are issues — the close transition applies.
    const closed = await this.closeIssue(id);
    return { id: closed.id, name: closed.title, state: "closed" };
  }

  async createMilestone(name: string): Promise<Milestone> {
    const projectId = await this.resolveProjectId();
    const raw = (await this.api("POST", "/rest/api/3/version",
      { name, projectId }, "jira milestone_create")) as
      { id: string; name: string; released?: boolean };
    return this.normalizeVersion(raw);
  }

  async listMilestones(): Promise<Milestone[]> {
    const raw = (await this.api("GET",
      `/rest/api/3/project/${this.cfg.projectKey}/versions`, undefined,
      "jira milestone_list")) as Array<{ id: string; name: string; released?: boolean }>;
    return raw.map((v) => this.normalizeVersion(v));
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const raw = (await this.api("PUT", `/rest/api/3/version/${id}`,
      { released: true }, "jira milestone_complete")) as
      { id: string; name: string; released?: boolean };
    return this.normalizeVersion(raw);
  }

  async commentIssue(id: string, text: string): Promise<{ id: string; url?: string }> {
    this.assertId(id);
    const raw = (await this.api("POST", `/rest/api/3/issue/${id}/comment`,
      { body: adf(text) }, "jira issue_comment")) as { id: string };
    return { id: raw.id };
  }

  async logWork(id: string, minutes: number): Promise<void> {
    this.assertId(id);
    await this.api("POST", `/rest/api/3/issue/${id}/worklog`,
      { timeSpentSeconds: minutes * 60 }, "jira worklog");
  }

  async attachFile(id: string, filename: string, data: Buffer,
    mediaType?: string): Promise<{ id?: string; url?: string }> {
    this.assertId(id);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)],
      { type: mediaType ?? "application/octet-stream" }), filename);
    const { email, token } = this.authProvider();
    // Multipart — no JSON content-type; fetch sets the boundary itself, and
    // Jira demands the XSRF opt-out header on this endpoint.
    const raw = (await fetchJson(this.fetchImpl,
      `${this.cfg.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${id}/attachments`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
          accept: "application/json",
          "X-Atlassian-Token": "no-check",
        },
        body: form,
      }, { context: "jira issue_attach" })) as Array<{ id?: string; content?: string }>;
    return { id: raw[0]?.id, url: raw[0]?.content };
  }
}
