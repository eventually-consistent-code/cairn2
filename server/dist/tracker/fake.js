import { CairnError } from "../errors.js";
export class FakeTracker {
    capabilities = {
        hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true,
    };
    issues = new Map();
    phases = new Map();
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
}
