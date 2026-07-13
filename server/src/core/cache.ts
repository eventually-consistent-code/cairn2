/**
 * Simple in-memory read cache with monotonic TTL expiry.
 */
export class ReadCache {
  private store = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly ttlMs = 60_000) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;

    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    return hit.value as T;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, { at: Date.now(), value });
  }

  clear(): void {
    this.store.clear();
  }
}
