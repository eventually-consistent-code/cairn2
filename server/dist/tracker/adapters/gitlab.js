import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginate } from "../http.js";
const WIP = "in-progress";
export class GitLabTracker {
    cfg;
    fetchImpl;
    capabilities = { hasInProgress: true, hasPhases: true, hasDependencies: true, hasLabels: true };
    constructor(cfg, fetchImpl = fetch) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
    }
    token() {
        const t = process.env[this.cfg.tokenEnv] ?? "";
        if (!t)
            throw new CairnError("AUTH_MISSING", `missing env ${this.cfg.tokenEnv}`, `export ${this.cfg.tokenEnv}=<gitlab token with api scope>`);
        return t;
    }
    base() { return `${this.cfg.baseUrl.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(this.cfg.project)}`; }
    headers() { return { "PRIVATE-TOKEN": this.token(), "content-type": "application/json" }; }
    api(method, path, body, op = "api") {
        return fetchJson(this.fetchImpl, `${this.base()}${path}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body) }, { context: `gitlab ${op}` });
    }
    assertId(id) {
        if (!/^\d+$/.test(id)) {
            throw new CairnError("NOT_FOUND", `invalid issue id: ${id}`, "issue id must be a numeric string");
        }
    }
    normalize(raw) {
        let state = raw.state === "closed" ? "closed" : "open";
        if (state === "open" && raw.labels.includes(WIP))
            state = "in_progress";
        return { id: String(raw.iid), title: raw.title, body: raw.description ?? "", state,
            labels: raw.labels.filter((l) => l !== WIP),
            phase: raw.milestone ? String(raw.milestone.id) : undefined,
            assignee: raw.assignee?.username, updatedAt: raw.updated_at, url: raw.web_url };
    }
    async createIssue(input) {
        if (input.phase && !/^\d+$/.test(input.phase)) {
            throw new CairnError("CONFIG_INVALID", `invalid phase: ${input.phase}`, "phase must be a numeric string");
        }
        const body = {
            title: input.title,
            description: input.body ?? "",
            labels: (input.labels ?? []).join(","),
        };
        if (input.phase)
            body.milestone_id = Number(input.phase);
        const raw = await this.api("POST", "/issues", body, "issue_create");
        return this.normalize(raw);
    }
    async getIssue(id) {
        this.assertId(id);
        const raw = await this.api("GET", `/issues/${id}`, undefined, "issue_get");
        return this.normalize(raw);
    }
    async updateIssue(id, patch) {
        this.assertId(id);
        const body = {};
        if (patch.title !== undefined)
            body.title = patch.title;
        if (patch.body !== undefined)
            body.description = patch.body;
        if (patch.labels !== undefined) {
            body.labels = patch.labels.filter((l) => l !== WIP).join(",");
        }
        if (patch.state === "closed") {
            body.state_event = "close";
        }
        else if (patch.state === "open") {
            // unconditional — GitLab reopens closed issues only via state_event; redundant reopen is a no-op
            body.state_event = "reopen";
            const current = patch.labels
                ? patch.labels.filter((l) => l !== WIP)
                : (await this.getIssue(id)).labels;
            body.labels = current.join(",");
        }
        else if (patch.state === "in_progress") {
            const current = patch.labels ?? (await this.getIssue(id)).labels;
            body.labels = [...new Set([...current, WIP])].join(",");
        }
        const raw = await this.api("PUT", `/issues/${id}`, body, "issue_update");
        return this.normalize(raw);
    }
    async closeIssue(id) {
        return this.updateIssue(id, { state: "closed" });
    }
    async listIssues(filter) {
        const raw = (await paginate(this.fetchImpl, `${this.base()}/issues?per_page=100&state=all`, { method: "GET", headers: this.headers() }, { context: "gitlab issue_list" }));
        let issues = raw.map((r) => this.normalize(r));
        if (filter?.phase)
            issues = issues.filter((i) => i.phase === filter.phase);
        if (filter?.state)
            issues = issues.filter((i) => i.state === filter.state);
        return issues;
    }
    async createPhase(name) {
        const raw = (await this.api("POST", "/milestones", { title: name }, "phase_create"));
        return { id: String(raw.id), name: raw.title, state: raw.state === "closed" ? "closed" : "open" };
    }
    async listPhases() {
        const raw = (await paginate(this.fetchImpl, `${this.base()}/milestones?state=all&per_page=100`, { method: "GET", headers: this.headers() }, { context: "gitlab phase_list" }));
        return raw.map((m) => ({ id: String(m.id), name: m.title, state: m.state === "closed" ? "closed" : "open" }));
    }
}
export const configSchema = z.object({
    baseUrl: z.string().url().default("https://gitlab.com"),
    project: z.string().min(1),
    tokenEnv: z.string().default("GITLAB_TOKEN"),
    extraLabels: z.array(z.string()).default([]),
});
export function make(config, fetchImpl) {
    return new GitLabTracker(config, fetchImpl);
}
