import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ViewStartupCoordinator,
  type ViewStartupHost,
} from "../src/view-startup";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHost(overrides: Partial<ViewStartupHost> = {}) {
  let layoutReady = false;
  const layoutCallbacks: Array<() => void> = [];
  const init = deferred<void>();
  const host: ViewStartupHost & {
    layoutCallbacks: Array<() => void>;
    init: ReturnType<typeof deferred<void>>;
    setLayoutReady(value: boolean): void;
    calls: {
      start: number;
      failure: unknown[];
      status: Array<{ status: string; detail?: string }>;
    };
  } = {
    layoutCallbacks,
    init,
    calls: { start: 0, failure: [], status: [] },
    setLayoutReady(value: boolean) {
      layoutReady = value;
      if (value) {
        for (const callback of [...layoutCallbacks]) {
          callback();
        }
      }
    },
    isLayoutReady: () => layoutReady,
    whenLayoutReady: (callback) => {
      layoutCallbacks.push(callback);
      if (layoutReady) {
        callback();
      }
    },
    startInitialization: async () => {
      host.calls.start += 1;
      await init.promise;
    },
    onFailure: (error) => {
      host.calls.failure.push(error);
    },
    onStatus: (status, detail) => {
      host.calls.status.push({ status, detail });
    },
    ...overrides,
  };
  return host;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ViewStartupCoordinator", () => {
  it("returns from begin within 100ms while layout is not ready and init never settles", async () => {
    const host = createHost();
    const coordinator = new ViewStartupCoordinator(host);

    const started = Date.now();
    coordinator.begin();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(coordinator.getPhase()).toBe("awaiting-layout");
    expect(host.calls.start).toBe(0);

    // init still pending forever — begin must not have awaited it
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.calls.start).toBe(0);
    expect(coordinator.getPhase()).toBe("awaiting-layout");
  });

  it("starts initialization only after layout becomes ready, and only once", async () => {
    const host = createHost();
    const coordinator = new ViewStartupCoordinator(host);

    coordinator.begin();
    coordinator.begin();
    expect(host.calls.start).toBe(0);

    host.setLayoutReady(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(host.calls.start).toBe(1);
    expect(coordinator.getPhase()).toBe("initializing");
    expect(host.calls.status.some((entry) => entry.status === "connecting")).toBe(
      true,
    );

    // duplicate layout-ready style callbacks must not double-start
    for (const callback of host.layoutCallbacks) {
      callback();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(host.calls.start).toBe(1);

    host.init.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getPhase()).toBe("ready");
  });

  it("defers initialization even when layout is already ready so begin stays non-blocking", async () => {
    const host = createHost();
    host.setLayoutReady(true);
    let startBegan = false;
    host.startInitialization = async () => {
      startBegan = true;
      host.calls.start += 1;
      await host.init.promise;
    };
    const coordinator = new ViewStartupCoordinator(host);

    coordinator.begin();
    expect(startBegan).toBe(false);
    expect(host.calls.start).toBe(0);

    await Promise.resolve();
    await Promise.resolve();
    expect(host.calls.start).toBe(1);
  });

  it("reports failure without unhandled rejection and allows retry after recreate path", async () => {
    const host = createHost();
    host.setLayoutReady(true);
    const coordinator = new ViewStartupCoordinator(host);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      coordinator.begin();
      await Promise.resolve();
      await Promise.resolve();
      const error = new Error("acp down");
      host.init.reject(error);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(coordinator.getPhase()).toBe("failed");
      expect(host.calls.failure).toEqual([error]);
      expect(unhandled).toEqual([]);
      expect(
        host.calls.status.some(
          (entry) => entry.status === "error" && entry.detail === "acp down",
        ),
      ).toBe(true);

      // retry with a fresh init deferred
      const second = deferred<void>();
      host.startInitialization = async () => {
        host.calls.start += 1;
        await second.promise;
      };
      coordinator.retry();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.calls.start).toBe(2);
      expect(coordinator.getPhase()).toBe("initializing");
      second.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.getPhase()).toBe("ready");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ignores late success and failure after close and bumps generation", async () => {
    const host = createHost();
    host.setLayoutReady(true);
    const coordinator = new ViewStartupCoordinator(host);
    const genAtStart = coordinator.getGeneration();

    coordinator.begin();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.calls.start).toBe(1);
    const genInitializing = coordinator.getGeneration();
    expect(genInitializing).toBeGreaterThan(genAtStart);

    coordinator.close();
    expect(coordinator.isClosed()).toBe(true);
    expect(coordinator.getPhase()).toBe("closed");
    expect(coordinator.getGeneration()).toBeGreaterThan(genInitializing);

    host.init.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.calls.failure).toEqual([]);
    expect(coordinator.getPhase()).toBe("closed");
    // no ready status after close
    expect(host.calls.status.some((entry) => entry.status === "ready")).toBe(
      false,
    );
  });

  it("ignores late failure after close", async () => {
    const host = createHost();
    host.setLayoutReady(true);
    const coordinator = new ViewStartupCoordinator(host);
    coordinator.begin();
    await Promise.resolve();
    await Promise.resolve();
    coordinator.close();
    host.init.reject(new Error("late"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.calls.failure).toEqual([]);
  });
});

describe("legacy blocking onOpen guard (reverse)", () => {
  it("fails the 100ms guard when onOpen awaits a never-settling initialize", async () => {
    const never = new Promise<void>(() => {});
    const legacyOnOpen = async () => {
      await never;
    };

    let timedOut = false;
    await Promise.race([
      legacyOnOpen().then(() => {
        timedOut = false;
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, 100);
      }),
    ]);

    // This documents the broken legacy behavior: still pending after 100ms.
    expect(timedOut).toBe(true);
  });
});
