/** One explicit send intent per tab. Cancelling invalidates late readiness completions. */
export class PendingSendStore<T> {
  private readonly entries = new Map<string, { payload: T }>();

  has(tabId: string): boolean { return this.entries.has(tabId); }

  add(tabId: string, payload: T): { payload: T } | undefined {
    if (this.entries.has(tabId)) return undefined;
    const entry = { payload };
    this.entries.set(tabId, entry);
    return entry;
  }

  take(tabId: string, entry: { payload: T }): T | undefined {
    if (this.entries.get(tabId) !== entry) return undefined;
    this.entries.delete(tabId);
    return entry.payload;
  }

  cancel(tabId: string): void { this.entries.delete(tabId); }
  clear(): void { this.entries.clear(); }
}
