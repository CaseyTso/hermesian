export interface DisconnectableTabClient {
  disconnect(): Promise<void>;
}

export interface TabClientSlot<TClient extends DisconnectableTabClient> {
  client: TClient;
  unsubscribe?: () => void;
}

export type TabClientFactory<TClient extends DisconnectableTabClient> = (
  tabId: string,
  isCurrent: () => boolean,
) => TabClientSlot<TClient>;

interface RegisteredTabClient<TClient extends DisconnectableTabClient>
  extends TabClientSlot<TClient> {}

export class TabClientRegistry<TClient extends DisconnectableTabClient> {
  private readonly slots = new Map<string, RegisteredTabClient<TClient>>();

  constructor(private readonly factory: TabClientFactory<TClient>) {}

  getOrCreate(tabId: string): TClient {
    const existing = this.slots.get(tabId);
    if (existing) {
      return existing.client;
    }

    let slot: RegisteredTabClient<TClient> | undefined;
    const isCurrent = (): boolean => this.slots.get(tabId) === slot;
    slot = this.factory(tabId, isCurrent);
    this.slots.set(tabId, slot);
    return slot.client;
  }

  peek(tabId: string): TClient | undefined {
    return this.slots.get(tabId)?.client;
  }

  some(predicate: (client: TClient) => boolean): boolean {
    return Array.from(this.slots.values()).some(({ client }) => predicate(client));
  }

  async release(tabId: string): Promise<void> {
    const slot = this.slots.get(tabId);
    if (!slot) {
      return;
    }
    this.slots.delete(tabId);
    slot.unsubscribe?.();
    await slot.client.disconnect();
  }

  async releaseExcept(tabId: string): Promise<void> {
    const releases = Array.from(this.slots.keys())
      .filter((candidate) => candidate !== tabId)
      .map((candidate) => this.release(candidate));
    await Promise.allSettled(releases);
  }

  async releaseAll(): Promise<void> {
    const slots = Array.from(this.slots.values());
    this.slots.clear();
    for (const slot of slots) {
      slot.unsubscribe?.();
    }
    await Promise.allSettled(slots.map(({ client }) => client.disconnect()));
  }
}
