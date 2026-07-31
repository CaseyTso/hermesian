import { describe, expect, it, vi } from "vitest";

import { ModelSaveCoordinator } from "../src/model-save-coordinator";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  saver: ModelSaveCoordinator;
  persist: ReturnType<typeof vi.fn>;
  memory: () => string[];
  errors: unknown[];
}

function makeHarness(initial: string[] = []): Harness {
  const persist = vi.fn<(value: string[]) => Promise<void>>();
  const errors: unknown[] = [];
  let memoryValue: string[] = [...initial];
  const saver = new ModelSaveCoordinator({
    initial,
    applyMemory: (value) => {
      memoryValue = [...value];
    },
    persist,
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    saver,
    persist,
    memory: () => [...memoryValue],
    errors,
  };
}

describe("ModelSaveCoordinator", () => {
  it("single success updates memory and disk", async () => {
    const h = makeHarness();
    h.persist.mockResolvedValue(undefined);
    await h.saver.save(["a", "b"]);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.persist.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(h.memory()).toEqual(["a", "b"]);
  });

  it("single failure rolls memory back to the last committed value and propagates", async () => {
    const h = makeHarness(["base"]);
    h.persist.mockResolvedValue(undefined);
    await h.saver.save(["base", "x"]); // committed = [base, x]
    h.persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.saver.save(["base", "y"])).rejects.toThrow("disk full");
    expect(h.memory()).toEqual(["base", "x"]);
    expect(h.errors).toHaveLength(1);
  });

  it("a stale failure after a newer request neither rolls back nor reports", async () => {
    const h = makeHarness(["base"]);
    const firstWrite = deferred<void>();
    h.persist.mockImplementationOnce(() => firstWrite.promise); // save A hangs
    const first = h.saver.save(["a"]);
    await tick(); // A's write has actually started
    // newer request B arrives while A's write is still in flight
    h.persist.mockResolvedValueOnce(undefined);
    const second = h.saver.save(["a", "b"]);
    // A fails late
    firstWrite.reject(new Error("late failure"));
    await expect(first).resolves.toBeUndefined();
    await second;
    expect(h.persist).toHaveBeenCalledTimes(2);
    expect(h.persist.mock.calls[1][0]).toEqual(["a", "b"]);
    expect(h.memory()).toEqual(["a", "b"]);
    expect(h.errors).toHaveLength(0);
  });

  it("a stale success is followed by a re-persist of the newest candidate", async () => {
    const h = makeHarness();
    const firstWrite = deferred<void>();
    h.persist.mockImplementationOnce(() => firstWrite.promise); // save A hangs
    const first = h.saver.save(["a"]);
    await tick(); // A's write has actually started
    h.persist.mockResolvedValueOnce(undefined);
    const second = h.saver.save(["a", "b"]);
    firstWrite.resolve(); // A succeeds late, after B was queued
    await first;
    await second;
    expect(h.persist).toHaveBeenCalledTimes(2);
    expect(h.persist.mock.calls[1][0]).toEqual(["a", "b"]);
    expect(h.memory()).toEqual(["a", "b"]);
  });

  it("a mixed failure sequence ends at the newest request and keeps the queue alive", async () => {
    const h = makeHarness(["base"]);
    h.persist.mockRejectedValueOnce(new Error("boom")); // A fails (no newer request yet)
    await expect(h.saver.save(["a"])).rejects.toThrow("boom");
    expect(h.memory()).toEqual(["base"]);
    h.persist.mockResolvedValueOnce(undefined); // B succeeds
    await h.saver.save(["a", "b"]);
    expect(h.memory()).toEqual(["a", "b"]);
    h.persist.mockRejectedValueOnce(new Error("boom2")); // C fails (newest)
    await expect(h.saver.save(["a", "b", "c"])).rejects.toThrow("boom2");
    expect(h.memory()).toEqual(["a", "b"]);
    // queue still works afterwards
    h.persist.mockResolvedValueOnce(undefined);
    await h.saver.save(["a", "b", "d"]);
    expect(h.memory()).toEqual(["a", "b", "d"]);
  });

  it("normalizes candidates and never shares mutable references", async () => {
    const h = makeHarness();
    h.persist.mockResolvedValue(undefined);
    const dirty = [" a ", "b", "a", "", "  "];
    const promise = h.saver.save(dirty);
    dirty.push("mutated");
    dirty[0] = "changed";
    await promise;
    expect(h.persist.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(h.memory()).toEqual(["a", "b"]);
  });

  it("reset re-baselines the committed value (startup reload)", async () => {
    const h = makeHarness(["old"]);
    h.saver.reset(["new", "new"]);
    h.persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.saver.save(["pending"])).rejects.toThrow("disk full");
    expect(h.memory()).toEqual(["new"]);
  });
});
