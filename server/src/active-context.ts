import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ActiveContextState { phase?: number; issueId?: string }

export class ActiveContext {
  private readonly path: string;
  private state: ActiveContextState;

  constructor(projectDir: string) {
    this.path = join(projectDir, ".cairn", "state", "active-context.json");
    try {
      this.state = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.state = {};
    }
  }

  get(): ActiveContextState {
    return { ...this.state };
  }

  set(patch: { phase?: number | null; issueId?: string | null }): void {
    for (const key of ["phase", "issueId"] as const) {
      const v = patch[key];
      if (v === null) delete this.state[key];
      else if (v !== undefined) (this.state as Record<string, unknown>)[key] = v;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2) + "\n");
  }
}
