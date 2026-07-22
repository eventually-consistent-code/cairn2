import { CairnError } from "../errors.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, Tracker,
} from "./types.js";

export class FakeTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
    hasMilestones: true, hasPhaseClose: true, hasComments: true,
  };
  private issues = new Map<string, Issue>();
  private phases = new Map<string, Phase>();
  private milestones = new Map<string, Milestone>();
  private issueComments = new Map<string, Array<{ id: string; text: string }>>();
  private seq = 0;

  async createIssue(input: IssueCreate): Promise<Issue> {
    const id = `FAKE-${++this.seq}`;
    const issue: Issue = {
      id, title: input.title, body: input.body ?? "", state: "open",
      labels: input.labels ?? [], phase: input.phase,
      updatedAt: new Date().toISOString(), url: `fake://issue/${id}`,
    };
    this.issues.set(id, issue);
    return { ...issue };
  }

  async getIssue(id: string): Promise<Issue> {
    const i = this.issues.get(id);
    if (!i) throw new CairnError("NOT_FOUND", `not found: ${id}`);
    return { ...i };
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    const i = await this.getIssue(id);
    const next: Issue = {
      ...i,
      title: patch.title ?? i.title,
      body: patch.body ?? i.body,
      state: (patch.state ?? i.state) as IssueState,
      labels: patch.labels ?? i.labels,
      assignee: patch.assignee ?? i.assignee,
      updatedAt: new Date().toISOString(),
    };
    this.issues.set(id, next);
    return { ...next };
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    return [...this.issues.values()]
      .filter((i) => (filter?.phase ? i.phase === filter.phase : true))
      .filter((i) => (filter?.state ? i.state === filter.state : true))
      .map((i) => ({ ...i }));
  }

  async createPhase(name: string): Promise<Phase> {
    const id = `FP-${++this.seq}`;
    const p: Phase = { id, name, state: "open" };
    this.phases.set(id, p);
    return { ...p };
  }

  async listPhases(): Promise<Phase[]> {
    return [...this.phases.values()].map((p) => ({ ...p }));
  }

  async closePhase(id: string): Promise<Phase> {
    const p = this.phases.get(id);
    if (!p) throw new CairnError("NOT_FOUND", `not found: ${id}`);
    const next: Phase = { ...p, state: "closed" };
    this.phases.set(id, next);
    return { ...next };
  }

  async createMilestone(name: string): Promise<Milestone> {
    const id = `FM-${++this.seq}`;
    const m: Milestone = { id, name, state: "open", url: `fake://milestone/${id}` };
    this.milestones.set(id, m);
    return { ...m };
  }

  async listMilestones(): Promise<Milestone[]> {
    return [...this.milestones.values()].map((m) => ({ ...m }));
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const m = this.milestones.get(id);
    if (!m) throw new CairnError("NOT_FOUND", `not found: ${id}`);
    const next: Milestone = { ...m, state: "released" };
    this.milestones.set(id, next);
    return { ...next };
  }

  async commentIssue(id: string, text: string): Promise<{ id: string; url?: string }> {
    await this.getIssue(id); // NOT_FOUND on unknown
    const list = this.issueComments.get(id) ?? [];
    const comment = { id: `FC-${++this.seq}`, text };
    list.push(comment);
    this.issueComments.set(id, list);
    return { id: comment.id, url: `fake://comment/${comment.id}` };
  }

  /** Test accessor: comments posted to an issue, in order. */
  comments(id: string): Array<{ id: string; text: string }> {
    return [...(this.issueComments.get(id) ?? [])];
  }
}
