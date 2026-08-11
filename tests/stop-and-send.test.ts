import { describe, expect, it, vi } from "vitest";

import {
  initialStopAndSendState,
  reduceStopAndSend,
  StopAndSendCoordinator,
  type StopAndSendState,
} from "../src/stop-and-send";

describe("stop-and-send reducer", () => {
  it("begins a stop by capturing exactly one immutable snapshot", () => {
    const state = reduceStopAndSend(initialStopAndSendState, {
      draft: "first message",
      type: "begin-stop",
    });

    expect(state).toMatchObject({
      phase: "stopping",
      snapshot: { draft: "first message" },
    });
    expect(state.lastError).toBeUndefined();

    // A second begin-stop must not overwrite the original snapshot.
    const again = reduceStopAndSend(state, {
      draft: "second message",
      type: "begin-stop",
    });
    expect(again.phase).toBe("stopping");
    expect(again.snapshot?.draft).toBe("first message");
  });

  it("waits on the barrier before allowing the send", () => {
    const stopping = reduceStopAndSend(initialStopAndSendState, {
      draft: "draft",
      type: "begin-stop",
    });
    expect(stopping.phase).toBe("stopping");

    const waiting = reduceStopAndSend(stopping, { type: "barrier-resolved" });
    expect(waiting.phase).toBe("waiting");
    expect(waiting.snapshot?.draft).toBe("draft");
  });

  it("restores the snapshot and reports the error when the barrier rejects", () => {
    const stopping = reduceStopAndSend(initialStopAndSendState, {
      draft: "draft to restore",
      type: "begin-stop",
    });

    const failed = reduceStopAndSend(stopping, {
      error: "cancel failed: transport closed",
      type: "barrier-rejected",
    });
    expect(failed.phase).toBe("idle");
    expect(failed.lastError).toBe("cancel failed: transport closed");
    // Snapshot is retained so the UI can restore it into the composer.
    expect(failed.snapshot?.draft).toBe("draft to restore");
  });

  it("ends the cycle after the send settles without retrying", () => {
    const waiting = reduceStopAndSend(
      reduceStopAndSend(initialStopAndSendState, {
        draft: "draft",
        type: "begin-stop",
      }),
      { type: "barrier-resolved" },
    );

    const done = reduceStopAndSend(waiting, { type: "send-succeeded" });
    expect(done.phase).toBe("idle");
    expect(done.lastError).toBeUndefined();

    const failed = reduceStopAndSend(waiting, {
      error: "send rejected",
      type: "send-failed",
    });
    expect(failed.phase).toBe("idle");
    expect(failed.lastError).toBe("send rejected");
  });

  it("ignores barrier signals outside a stop-and-send cycle", () => {
    expect(reduceStopAndSend(initialStopAndSendState, { type: "barrier-resolved" })).toBe(
      initialStopAndSendState,
    );
    expect(
      reduceStopAndSend(initialStopAndSendState, {
        error: "late failure",
        type: "barrier-rejected",
      }),
    ).toBe(initialStopAndSendState);
  });
});

describe("stop-and-send coordinator", () => {
  function deferredBarrier(): {
    barrier: Promise<void>;
    reject: (reason?: unknown) => void;
    resolve: () => void;
  } {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const barrier = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { barrier, reject, resolve };
  }

  it("sends the snapshot exactly once when the barrier resolves", async () => {
    const send = vi.fn(async () => undefined);
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("message at stop time", barrier.barrier);
    expect(coordinator.getState().phase).toBe("stopping");
    expect(send).not.toHaveBeenCalled();

    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("message at stop time");
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("does not send until the barrier resolves, with no timer guessing", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => undefined);
      const coordinator = new StopAndSendCoordinator(send);
      const barrier = deferredBarrier();

      coordinator.beginStop("pending message", barrier.barrier);
      expect(coordinator.getState().phase).toBe("stopping");

      // Advancing time alone must never trigger the send — only the injected
      // barrier promise may. This proves there is no setTimeout guess.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(send).not.toHaveBeenCalled();
      expect(coordinator.getState().phase).toBe("stopping");

      barrier.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the snapshot and reports the error when the barrier rejects", async () => {
    const send = vi.fn(async () => undefined);
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("cancel failed message", barrier.barrier);
    barrier.reject(new Error("cancel was interrupted"));

    await Promise.resolve();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    expect(coordinator.getState().phase).toBe("idle");
    expect(coordinator.getState().lastError).toBe("cancel was interrupted");
    expect(coordinator.getState().snapshot?.draft).toBe("cancel failed message");
  });

  it("reports a send failure without retrying or emitting queue copy", async () => {
    const send = vi.fn<(draft: string) => Promise<void>>(async () => {
      throw new Error("new turn failed");
    });
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("message", barrier.barrier);
    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(coordinator.getState().phase).toBe("idle");
    expect(coordinator.getState().lastError).toBe("new turn failed");
    expect(send.mock.calls[0][0]).toBe("message");
    expect(send.mock.calls[0][0]).not.toContain("Queued for the next turn");
  });

  it("keeps new input during stopping as a separate draft, never touching the snapshot", async () => {
    const send = vi.fn(async () => undefined);
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("snapshot draft", barrier.barrier);

    // New typing during stopping is an independent concern; a second
    // begin-stop must not clobber the in-flight snapshot.
    coordinator.beginStop("new draft typed while stopping", barrier.barrier);
    expect(coordinator.getState().snapshot?.draft).toBe("snapshot draft");

    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("snapshot draft");
  });

  it("ignores begin-stop while a stop-and-send cycle is already waiting", async () => {
    const send = vi.fn(async () => undefined);
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("first", barrier.barrier);
    barrier.resolve();
    await Promise.resolve();

    // The send is in flight (waiting phase) — a new stop must not start.
    coordinator.beginStop("second", Promise.resolve());
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("first");
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("exposes a serializable state that never contains queue copy", () => {
    const coordinator = new StopAndSendCoordinator(vi.fn(async () => undefined));
    const state: StopAndSendState = coordinator.getState();
    expect(JSON.stringify(state)).not.toContain("Queued for the next turn");
    expect(JSON.stringify(state)).not.toContain("/steer");
  });
});
