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

  it("synchronous A/B/C all fail: only the newest rejects, exactly one onError, memory back to committed", async () => {
    const h = makeHarness(["base"]);
    h.persist.mockRejectedValue(new Error("disk"));
    const a = h.saver.save(["a"]);
    const b = h.saver.save(["a", "b"]);
    const c = h.saver.save(["a", "b", "c"]);
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    await expect(c).rejects.toThrow("disk");
    expect(h.persist).toHaveBeenCalledTimes(3);
    expect(h.persist.mock.calls.map((call) => call[0])).toEqual([
      ["a"],
      ["a", "b"],
      ["a", "b", "c"],
    ]);
    expect(h.memory()).toEqual(["base"]);
    expect(h.errors).toHaveLength(1);
  });

  it("A and B succeed then C fails: C rejects, memory rolls back to B, write order A/B/C", async () => {
    const h = makeHarness();
    h.persist.mockResolvedValueOnce(undefined); // A
    h.persist.mockResolvedValueOnce(undefined); // B
    h.persist.mockRejectedValueOnce(new Error("boom")); // C
    const a = h.saver.save(["a"]);
    const b = h.saver.save(["a", "b"]);
    const c = h.saver.save(["a", "b", "c"]);
    await a;
    await b;
    await expect(c).rejects.toThrow("boom");
    expect(h.persist.mock.calls.map((call) => call[0])).toEqual([
      ["a"],
      ["a", "b"],
      ["a", "b", "c"],
    ]);
    expect(h.memory()).toEqual(["a", "b"]);
  });

  it("A and B fail then C succeeds: stale failures are silent and C wins", async () => {
    const h = makeHarness(["base"]);
    h.persist.mockRejectedValueOnce(new Error("a fails")); // A
    h.persist.mockRejectedValueOnce(new Error("b fails")); // B
    h.persist.mockResolvedValueOnce(undefined); // C
    const a = h.saver.save(["a"]);
    const b = h.saver.save(["a", "b"]);
    const c = h.saver.save(["a", "b", "c"]);
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    await c;
    expect(h.memory()).toEqual(["a", "b", "c"]);
    expect(h.errors).toHaveLength(0);
  });

  it("the queue keeps working after a latest failure", async () => {
    const h = makeHarness(["base"]);
    h.persist.mockRejectedValueOnce(new Error("boom"));
    await expect(h.saver.save(["x"])).rejects.toThrow("boom");
    h.persist.mockResolvedValueOnce(undefined);
    await h.saver.save(["d"]);
    expect(h.memory()).toEqual(["d"]);
  });

  it("mutating the caller's array after save does not affect the write", async () => {
    const h = makeHarness();
    h.persist.mockResolvedValue(undefined);
    const arr = ["a"];
    const pending = h.saver.save(arr);
    arr.push("mutated");
    arr[0] = "changed";
    await pending;
    expect(h.persist.mock.calls[0][0]).toEqual(["a"]);
  });
});
