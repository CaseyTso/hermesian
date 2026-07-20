import { describe, expect, it, vi } from "vitest";

import { TabClientRegistry } from "../src/tab-client-registry";

interface FakeClient {
  disconnect: () => Promise<void>;
  id: number;
}

describe("TabClientRegistry", () => {
  it("reuses a client within one tab and isolates different tabs", () => {
    let nextId = 1;
    const registry = new TabClientRegistry<FakeClient>(() => ({
      client: { disconnect: vi.fn(async () => undefined), id: nextId++ },
    }));

    const firstA = registry.getOrCreate("a");
    expect(registry.getOrCreate("a")).toBe(firstA);
    expect(registry.getOrCreate("b")).not.toBe(firstA);
  });

  it("invalidates callbacks before disconnect and creates a fresh replacement", async () => {
    let nextId = 1;
    const forwarded: string[] = [];
    const emitters = new Map<string, Array<() => void>>();
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const registry = new TabClientRegistry<FakeClient>((tabId, isCurrent) => {
      const emit = (): void => {
        if (isCurrent()) {
          forwarded.push(tabId);
        }
      };
      const emittersForTab = emitters.get(tabId) ?? [];
      emittersForTab.push(emit);
      emitters.set(tabId, emittersForTab);
      const unsubscribe = vi.fn();
      unsubscribes.push(unsubscribe);
      return {
        client: { disconnect: vi.fn(async () => undefined), id: nextId++ },
        unsubscribe,
      };
    });

    const oldA = registry.getOrCreate("a");
    const oldEmitter = emitters.get("a")![0];
    oldEmitter();
    await registry.release("a");
    oldEmitter();
    const newA = registry.getOrCreate("a");
    emitters.get("a")![1]();

    expect(forwarded).toEqual(["a", "a"]);
    expect(newA).not.toBe(oldA);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    expect(oldA.disconnect).toHaveBeenCalledOnce();
  });

  it("releaseAll clears every identity before awaiting disconnect", async () => {
    const disconnectResolvers: Array<() => void> = [];
    const registry = new TabClientRegistry<FakeClient>(() => ({
      client: {
        disconnect: vi.fn(
          () => new Promise<void>((resolve) => disconnectResolvers.push(resolve)),
        ),
        id: disconnectResolvers.length + 1,
      },
    }));
    const a = registry.getOrCreate("a");
    const b = registry.getOrCreate("b");

    const release = registry.releaseAll();
    expect(registry.peek("a")).toBeUndefined();
    expect(registry.peek("b")).toBeUndefined();
    expect(a.disconnect).toHaveBeenCalledOnce();
    expect(b.disconnect).toHaveBeenCalledOnce();
    disconnectResolvers.forEach((resolve) => resolve());
    await release;
  });
});
