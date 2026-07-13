/**
 * Simple in-memory read cache with monotonic TTL expiry.
 */
export class ReadCache {
    ttlMs;
    store = new Map();
    constructor(ttlMs = 60_000) {
        this.ttlMs = ttlMs;
    }
    get(key) {
        const hit = this.store.get(key);
        if (!hit)
            return undefined;
        if (Date.now() - hit.at > this.ttlMs) {
            this.store.delete(key);
            return undefined;
        }
        return hit.value;
    }
    set(key, value) {
        this.store.set(key, { at: Date.now(), value });
    }
    clear() {
        this.store.clear();
    }
}
