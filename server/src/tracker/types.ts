export type IssueState = "open" | "in_progress" | "closed";

export interface Issue {
  id: string;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  phase?: string;
  assignee?: string;
  updatedAt: string; // ISO-8601 UTC
  url: string;
}

export interface Phase {
  id: string;
  name: string;
  number?: number;
  state: "open" | "closed";
}

export interface Capability {
  hasInProgress: boolean;
  hasPhases: boolean;
  hasDependencies: boolean;
  hasLabels: boolean;
}

export interface IssueCreate {
  title: string;
  body?: string;
  labels?: string[];
  phase?: string;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: IssueState;
  labels?: string[];
  assignee?: string;
}

export interface Tracker {
  readonly capabilities: Capability;
  createIssue(input: IssueCreate): Promise<Issue>;
  getIssue(id: string): Promise<Issue>;
  updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
  closeIssue(id: string): Promise<Issue>;
  listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]>;
  createPhase(name: string): Promise<Phase>;
  listPhases(): Promise<Phase[]>;
}
