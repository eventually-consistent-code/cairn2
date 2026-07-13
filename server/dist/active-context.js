import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
export class ActiveContext {
    path;
    state;
    constructor(projectDir) {
        this.path = join(projectDir, ".cairn", "state", "active-context.json");
        try {
            this.state = JSON.parse(readFileSync(this.path, "utf8"));
        }
        catch {
            this.state = {};
        }
    }
    get() {
        return { ...this.state };
    }
    set(patch) {
        for (const key of ["phase", "issueId"]) {
            const v = patch[key];
            if (v === null)
                delete this.state[key];
            else if (v !== undefined)
                this.state[key] = v;
        }
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(this.state, null, 2) + "\n");
    }
}
