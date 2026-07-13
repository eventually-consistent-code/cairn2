import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker,
} from "../types.js";

const API = "https://app.asana.com/api/1.0";
const OPT_FIELDS = "name,notes,completed,modified_at,memberships.section.gid";
const LIST_CAP = 100;

export const configSchema = z.object({
  projectGid: z.string().regex(/^\d+$/),
  tokenEnv: z.string().default("ASANA_TOKEN"),
});

export function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker {
  return new AsanaTracker(config, fetchImpl);
}

interface AsanaTask {
  gid: string; name: string; notes: string | null; completed: boolean;
  modified_at: string;
  memberships?: Array<{ section?: { gid: string } }>;
}

interface AsanaSection {
  gid: string; name: string;
}

export class AsanaTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: false, hasPhases: true, hasDependencies: true, hasLabels: false,
  };

  constructor(
    private readonly cfg: { projectGid: string; tokenEnv: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly tokenProvider: () => string = () => resolveAsanaToken(cfg.tokenEnv),
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.tokenProvider()}`,
      "content-type": "application/json",
    };
  }

  private async api(method: string, path: string, body?: unknown, context?: string): Promise<unknown> {
    const raw = await fetchJson(this.fetchImpl, `${API}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { context: context ? `asana ${context}` : "asana" });
    return (raw as { data?: unknown }).data;
  }

  private assertId(id: string): void {
    if (!/^\d+$/.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid task id: ${id}`,
        "task id must be a numeric gid");
    }
  }

  private normalize(raw: AsanaTask): Issue {
    const sectionGid = raw.memberships?.[0]?.section?.gid;
    return {
      id: raw.gid, title: raw.name, body: raw.notes ?? "",
      state: raw.completed ? "closed" : "open",
      labels: [],
      phase: sectionGid,
      updatedAt: raw.modified_at,
      url: `https://app.asana.com/0/${this.cfg.projectGid}/${raw.gid}`,
    };
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    if (input.phase && !/^\d+$/.test(input.phase)) {
      throw new CairnError("CONFIG_INVALID",
        `invalid phase: ${input.phase}`,
        "phase must be a numeric section gid");
    }
    const body = {
      data: {
        name: input.title, notes: input.body ?? "",
        projects: [this.cfg.projectGid],
      },
    };
    const raw = (await this.api("POST", "/tasks", body, "issue_create")) as AsanaTask;
    if (input.phase) {
      await this.api("POST", `/sections/${input.phase}/addTask`,
        { data: { task: raw.gid } }, "issue_assign_phase");
    }
    return this.normalize({ ...raw, memberships: input.phase
      ? [{ section: { gid: input.phase } }] : raw.memberships });
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api("GET", `/tasks/${id}?opt_fields=${OPT_FIELDS}`,
      undefined, "issue_get");
    return this.normalize(raw as AsanaTask);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.name = patch.title;
    if (patch.body !== undefined) body.notes = patch.body;
    // Asana has no native in-progress state: in_progress and open both map
    // to completed:false. Never write completed:true except for an explicit close.
    if (patch.state === "closed") body.completed = true;
    if (patch.state === "open" || patch.state === "in_progress") body.completed = false;
    const raw = await this.api("PUT", `/tasks/${id}`, { data: body }, "issue_update");
    return this.normalize(raw as AsanaTask);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    let raw: AsanaTask[];
    if (filter?.phase) {
      if (!/^\d+$/.test(filter.phase)) {
        throw new CairnError("NOT_FOUND", `invalid phase: ${filter.phase}`,
          "phase must be a numeric section gid");
      }
      const list = await this.api("GET",
        `/sections/${filter.phase}/tasks?opt_fields=${OPT_FIELDS}`,
        undefined, "issue_list_phase");
      raw = list as AsanaTask[];
    } else {
      const list = await this.api("GET",
        `/projects/${this.cfg.projectGid}/tasks?opt_fields=${OPT_FIELDS}&limit=${LIST_CAP}`,
        undefined, "issue_list");
      raw = list as AsanaTask[];
      if (raw.length === LIST_CAP) {
        console.error(`[cairn] asana issue_list truncated at ${LIST_CAP} items for project ${this.cfg.projectGid}`);
      }
    }
    let issues = raw.map((r) => this.normalize(r));
    if (filter?.state) issues = issues.filter((i) => i.state === filter.state);
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const raw = (await this.api("POST", `/projects/${this.cfg.projectGid}/sections`,
      { data: { name } }, "phase_create")) as AsanaSection;
    return { id: raw.gid, name: raw.name, state: "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = (await this.api("GET", `/projects/${this.cfg.projectGid}/sections`,
      undefined, "phase_list")) as AsanaSection[];
    return raw.map((s) => ({ id: s.gid, name: s.name, state: "open" as const }));
  }
}

export function resolveAsanaToken(tokenEnv: string): string {
  const env = process.env[tokenEnv];
  if (env) return env;
  throw new CairnError("AUTH_MISSING", `no Asana credentials (${tokenEnv})`,
    `export ${tokenEnv}`);
}
