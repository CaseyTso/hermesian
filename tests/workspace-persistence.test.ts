import { describe, expect, it, vi } from "vitest";

import {
  assignAndPersistWithRollback,
  type AssignedValuePort,
} from "../src/workspace-persistence";

function makePort(initial: string, persistFn?: () => Promise<void>): AssignedValuePort<string> {
  let value = initial;
  return {
    get: () => value,
    set: (next) => { value = next; },
    persist: persistFn ?? vi.fn(async () => undefined),
  };
}

describe("assignAndPersistWithRollback", () => {
  it("persists the candidate and keeps it on success", async () => {
    const persist = vi.fn(async () => undefined);
    const port = makePort("old", persist);

    await assignAndPersistWithRollback(port, "new");

    expect(port.get()).toBe("new");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("restores the previous value when persist rejects", async () => {
    const port = makePort("old", vi.fn(async () => {
      throw new Error("save failed");
    }));

    await expect(assignAndPersistWithRollback(port, "new")).rejects.toThrow("save failed");
    expect(port.get()).toBe("old");
  });

  it("does not overwrite a newer assignment when rollback fires", async () => {
    const port = makePort("old", vi.fn(async () => {
      throw new Error("save failed");
    }));

    const promise = assignAndPersistWithRollback(port, "candidate-a");
    // Another assignment happens before persist rejects
    port.set("candidate-b");

    await expect(promise).rejects.toThrow("save failed");
    // Rollback must NOT overwrite candidate-b with old
    expect(port.get()).toBe("candidate-b");
  });

  it("never calls persist twice", async () => {
    const persist = vi.fn(async () => undefined);
    const port = makePort("old", persist);

    await assignAndPersistWithRollback(port, "new");

    expect(persist).toHaveBeenCalledTimes(1);
  });
});
