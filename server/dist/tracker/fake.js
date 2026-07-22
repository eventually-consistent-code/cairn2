import { CairnError } from "../errors.js";
export class FakeTracker {
    capabilities = {
        hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
        hasMilestones: true, hasPhaseClose: true, hasComments: true,
    };
    issues = new Map();
    phases = new Map();
    milestones = new Map();
    issueComments = new Map();
    seq = 0;
    async createIssue(input) {
        const id = `FAKE-${++this.seq}`;
        const issue = {
            id, title: input.title, body: input.body ?? "", state: "open",
            labels: input.labels ?? [], phase: input.phase,
            updatedAt: new Date().toISOString(), url: `fake://issue/${id}`,
        };
        this.issues.set(id, issue);
        return { ...issue };
    }
    async getIssue(id) {
        const i = this.issues.get(id);
        if (!i)
            throw new CairnError("NOT_FOUND", `not found: ${id}`);
        return { ...i };
    }
    async updateIssue(id, patch) {
        const i = await this.getIssue(id);
        const next = {
            ...i,
            title: patch.title ?? i.title,
            body: patch.body ?? i.body,
            state: (patch.state ?? i.state),
            labels: patch.labels ?? i.labels,
            assignee: patch.assignee ?? i.assignee,
            updatedAt: new Date().toISOString(),
        };
        this.issues.set(id, next);
        return { ...next };
    }
    async closeIssue(id) {
        return this.updateIssue(id, { state: "closed" });
    }
    async listIssues(filter) {
        return [...this.issues.values()]
            .filter((i) => (filter?.phase ? i.phase === filter.phase : true))
            .filter((i) => (filter?.state ? i.state === filter.state : true))
            .map((i) => ({ ...i }));
    }
    async createPhase(name) {
        const id = `FP-${++this.seq}`;
        const p = { id, name, state: "open" };
        this.phases.set(id, p);
        return { ...p };
    }
    async listPhases() {
        return [...this.phases.values()].map((p) => ({ ...p }));
    }
    async closePhase(id) {
        const p = this.phases.get(id);
        if (!p)
            throw new CairnError("NOT_FOUND", `not found: ${id}`);
        const next = { ...p, state: "closed" };
        this.phases.set(id, next);
        return { ...next };
    }
    async createMilestone(name) {
        const id = `FM-${++this.seq}`;
        const m = { id, name, state: "open", url: `fake://milestone/${id}` };
        this.milestones.set(id, m);
        return { ...m };
    }
    async listMilestones() {
        return [...this.milestones.values()].map((m) => ({ ...m }));
    }
    async completeMilestone(id) {
        const m = this.milestones.get(id);
        if (!m)
            throw new CairnError("NOT_FOUND", `not found: ${id}`);
        const next = { ...m, state: "released" };
        this.milestones.set(id, next);
        return { ...next };
    }
    async commentIssue(id, text) {
        await this.getIssue(id); // NOT_FOUND on unknown
        const list = this.issueComments.get(id) ?? [];
        const comment = { id: `FC-${++this.seq}`, text };
        list.push(comment);
        this.issueComments.set(id, list);
        return { id: comment.id, url: `fake://comment/${comment.id}` };
    }
    /** Test accessor: comments posted to an issue, in order. */
    comments(id) {
        return [...(this.issueComments.get(id) ?? [])];
    }
}
