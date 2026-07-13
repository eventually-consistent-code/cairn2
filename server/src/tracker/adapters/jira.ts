import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker,
} from "../types.js";

// Issue keys look like PROJ-123 (letters + digits, dash, digits).
const ID_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
const MAX_RESULTS = 100;

const STATUS_CATEGORY_MAP: Record<string, IssueState> = {
  new: "open", indeterminate: "in_progress", done: "closed",
};

export const configSchema = z.object({
  baseUrl: z.string().url(),
  projectKey: z.string().min(1),
  issueType: z.string().default("Task"),
  emailEnv: z.string().default("JIRA_EMAIL"),
  tokenEnv: z.string().default("JIRA_API_TOKEN"),
  transitions: z.object({ in_progress: z.string(), closed: z.string() })
    .default({ in_progress: "In Progress", closed: "Done" }),
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
  status: { statusCategory: { key: string } };
  updated: string;
  labels?: string[];
  parent?: { key: string };
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
  };

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
    const state = STATUS_CATEGORY_MAP[f.status?.statusCategory?.key ?? "new"] ?? "open";
    return {
      id: raw.key,
      title: f.summary,
      body: f.description ? adfToText(f.description) : "",
      state,
      labels: f.labels ?? [],
      phase: f.parent?.key,
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

  async createIssue(input: IssueCreate): Promise<Issue> {
    const fields: Record<string, unknown> = {
      project: { key: this.cfg.projectKey },
      summary: input.title,
      description: adf(input.body ?? ""),
      issuetype: { name: this.cfg.issueType },
    };
    if (input.labels?.length) fields.labels = input.labels;
    if (input.phase) fields.parent = { key: input.phase };
    const created = (await this.api("POST", "/rest/api/3/issue", { fields },
      "jira issue_create")) as { key: string };
    return this.getIssue(created.key);
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api("GET",
      `/rest/api/3/issue/${id}?fields=summary,description,status,updated,labels,parent`,
      undefined, "jira issue_get");
    return this.normalize(raw as JiraIssue);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.body !== undefined) fields.description = adf(patch.body);
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (Object.keys(fields).length > 0) {
      await this.api("PUT", `/rest/api/3/issue/${id}`, { fields }, "jira issue_update");
    }
    if (patch.state === "in_progress") {
      await this.transitionByName(id, this.cfg.transitions.in_progress);
    } else if (patch.state === "closed") {
      await this.transitionByName(id, this.cfg.transitions.closed);
    } else if (patch.state === "open") {
      await this.transitionToOpenCategory(id);
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
    const raw = (await this.api("POST", "/rest/api/3/search", {
      jql,
      maxResults: MAX_RESULTS,
      fields: ["summary", "description", "status", "updated", "labels", "parent"],
    }, "jira issue_list")) as { issues: JiraIssue[]; total?: number };
    if (raw.issues.length === MAX_RESULTS) {
      console.error(`[cairn] jira issue_list truncated at ${MAX_RESULTS} results (total: ${raw.total ?? "unknown"})`);
    }
    let issues = raw.issues.map((i) => this.normalize(i));
    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
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
    const raw = (await this.api("POST", "/rest/api/3/search", {
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
}
