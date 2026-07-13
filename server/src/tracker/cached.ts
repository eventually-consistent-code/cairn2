import { ReadCache } from "../core/cache.js";
import type {
  Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker,
} from "./types.js";

/**
 * Caches read operations (getIssue, listIssues, listPhases) for 60s.
 * Any write invalidates the entire cache (whole-cache write-through invalidation).
 * All cached values are deep-cloned on read to prevent caller mutation poisoning.
 */
export class CachedTracker implements Tracker {
  readonly capabilities: Capability;
  private cache: ReadCache;

  constructor(
    private inner: Tracker,
    cache?: ReadCache,
  ) {
    this.capabilities = inner.capabilities;
    this.cache = cache ?? new ReadCache(60_000);
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const result = await this.inner.createIssue(input);
    this.cache.clear();
    return result;
  }

  async getIssue(id: string): Promise<Issue> {
    const key = `issue:${id}`;
    const cached = this.cache.get<Issue>(key);
    if (cached) return this.clone(cached);

    const result = await this.inner.getIssue(id);
    this.cache.set(key, this.clone(result));
    return result;
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    const result = await this.inner.updateIssue(id, patch);
    this.cache.clear();
    return result;
  }

  async closeIssue(id: string): Promise<Issue> {
    const result = await this.inner.closeIssue(id);
    this.cache.clear();
    return result;
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const key = `list:${JSON.stringify(filter ?? {})}`;
    const cached = this.cache.get<Issue[]>(key);
    if (cached) return this.clone(cached);

    const result = await this.inner.listIssues(filter);
    this.cache.set(key, this.clone(result));
    return result;
  }

  async createPhase(name: string): Promise<Phase> {
    const result = await this.inner.createPhase(name);
    this.cache.clear();
    return result;
  }

  async listPhases(): Promise<Phase[]> {
    const key = "phases";
    const cached = this.cache.get<Phase[]>(key);
    if (cached) return this.clone(cached);

    const result = await this.inner.listPhases();
    this.cache.set(key, this.clone(result));
    return result;
  }
}
