import { ReadCache } from "../core/cache.js";
/**
 * Caches read operations (getIssue, listIssues, listPhases) for 60s.
 * Any write invalidates the entire cache (whole-cache write-through invalidation).
 * All cached values are deep-cloned on read to prevent caller mutation poisoning.
 */
export class CachedTracker {
    inner;
    capabilities;
    cache;
    constructor(inner, cache) {
        this.inner = inner;
        this.capabilities = inner.capabilities;
        this.cache = cache ?? new ReadCache(60_000);
    }
    clone(value) {
        return structuredClone(value);
    }
    async createIssue(input) {
        const result = await this.inner.createIssue(input);
        this.cache.clear();
        return result;
    }
    async getIssue(id) {
        const key = `issue:${id}`;
        const cached = this.cache.get(key);
        if (cached)
            return this.clone(cached);
        const result = await this.inner.getIssue(id);
        this.cache.set(key, this.clone(result));
        return result;
    }
    async updateIssue(id, patch) {
        const result = await this.inner.updateIssue(id, patch);
        this.cache.clear();
        return result;
    }
    async closeIssue(id) {
        const result = await this.inner.closeIssue(id);
        this.cache.clear();
        return result;
    }
    async listIssues(filter) {
        const key = `list:${JSON.stringify(filter ?? {})}`;
        const cached = this.cache.get(key);
        if (cached)
            return this.clone(cached);
        const result = await this.inner.listIssues(filter);
        this.cache.set(key, this.clone(result));
        return result;
    }
    async createPhase(name) {
        const result = await this.inner.createPhase(name);
        this.cache.clear();
        return result;
    }
    async listPhases() {
        const key = "phases";
        const cached = this.cache.get(key);
        if (cached)
            return this.clone(cached);
        const result = await this.inner.listPhases();
        this.cache.set(key, this.clone(result));
        return result;
    }
}
