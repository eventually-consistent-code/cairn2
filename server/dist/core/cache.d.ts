/**
 * Simple in-memory read cache with monotonic TTL expiry.
 */
export declare class ReadCache {
    private readonly ttlMs;
    private store;
    constructor(ttlMs?: number);
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    clear(): void;
}
