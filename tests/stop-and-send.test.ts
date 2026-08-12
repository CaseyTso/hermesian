import { describe, expect, it, vi } from "vitest";

import {
  assertStopAndSendCanSend,
  continuedDraftAfterStopAndSend,
  initialStopAndSendState,
  isStopAndSendUiBlocking,
  reduceStopAndSend,
  runStopAndSendComposerHandoff,
  runStopAndSendCycleHandoff,
  shouldCompleteStopAndSendCycleAt,
  shouldRestoreContinuedDraftAt,
  StopAndSendCoordinator,
  type StopAndSendSendFn,
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

  /** Unit-test send that settles immediately without long-lived turn. */
  const instantSend: StopAndSendSendFn = async () => undefined;

  it("sends the snapshot exactly once when the barrier resolves", async () => {
    const send = vi.fn(instantSend);
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("message at stop time", barrier.barrier);
    expect(coordinator.getState().phase).toBe("stopping");
    expect(send).not.toHaveBeenCalled();

    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe("message at stop time");
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("does not send until the barrier resolves, with no timer guessing", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(instantSend);
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
    const send = vi.fn(instantSend);
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
    const send = vi.fn<StopAndSendSendFn>(async () => {
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
    const send = vi.fn(instantSend);
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
    expect(send.mock.calls[0][0]).toBe("snapshot draft");
  });

  it("ignores begin-stop while a stop-and-send cycle is already waiting", async () => {
    const send = vi.fn(instantSend);
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
    expect(send.mock.calls[0][0]).toBe("first");
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("leaves Stopping… at onDispatched while sendPrompt is still pending", async () => {
    let releaseTurn!: () => void;
    const turnInFlight = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const phases: string[] = [];
    const send: StopAndSendSendFn = async (_draft, hooks) => {
      // Model View: restore continued draft, then fire onDispatched, then await.
      hooks.onDispatched();
      phases.push(coordinator.getState().phase);
      await turnInFlight;
    };
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();

    coordinator.beginStop("snapshot at stop", barrier.barrier);
    expect(isStopAndSendUiBlocking(coordinator.getState().phase)).toBe(true);

    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // While follow-up sendPrompt is still pending, cycle must already be idle.
    expect(coordinator.getState().phase).toBe("idle");
    expect(isStopAndSendUiBlocking(coordinator.getState().phase)).toBe(false);
    expect(phases).toEqual(["idle"]);
    expect(coordinator.getState().snapshot).toBeUndefined();

    // Esc/Stop can target the new in-flight turn (not blocked by stop-and-send).
    expect(shouldCompleteStopAndSendCycleAt("dispatch-started")).toBe(true);
    expect(shouldCompleteStopAndSendCycleAt("turn-complete")).toBe(false);

    releaseTurn();
    await Promise.resolve();
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("retains snapshot on pre-dispatch failure but not after onDispatched", async () => {
    // Pre-dispatch throw → send-failed + snapshot retained.
    const pre = vi.fn<StopAndSendSendFn>(async () => {
      throw new Error("guards failed");
    });
    const c1 = new StopAndSendCoordinator(pre);
    const b1 = deferredBarrier();
    c1.beginStop("must restore", b1.barrier);
    b1.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(c1.getState().phase).toBe("idle");
    expect(c1.getState().lastError).toBe("guards failed");
    expect(c1.getState().snapshot?.draft).toBe("must restore");

    // Post-dispatch throw → normal turn error; cycle already idle, no restore.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const post = vi.fn<StopAndSendSendFn>(async (_draft, hooks) => {
      hooks.onDispatched();
      await pending;
      throw new Error("agent turn failed after dispatch");
    });
    const c2 = new StopAndSendCoordinator(post);
    const b2 = deferredBarrier();
    c2.beginStop("already on wire", b2.barrier);
    b2.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(c2.getState().phase).toBe("idle");
    expect(c2.getState().snapshot).toBeUndefined();
    expect(c2.getState().lastError).toBeUndefined();
    release();
    await Promise.resolve();
    await Promise.resolve();
    // Still idle with no lastError from coordinator — post-dispatch owns UX.
    expect(c2.getState().phase).toBe("idle");
    expect(c2.getState().lastError).toBeUndefined();
  });

  it("exposes a serializable state that never contains queue copy", () => {
    const coordinator = new StopAndSendCoordinator(vi.fn(instantSend));
    const state: StopAndSendState = coordinator.getState();
    expect(JSON.stringify(state)).not.toContain("Queued for the next turn");
    expect(JSON.stringify(state)).not.toContain("/steer");
  });
});

describe("stop-and-send send guards + continued draft", () => {
  it("throws when send is unavailable so the coordinator can restore the snapshot", () => {
    expect(() =>
      assertStopAndSendCanSend({
        hasActiveTab: true,
        hasRequest: true,
        hasSession: true,
        permissionPending: false,
        sendAvailable: false,
        tabBusy: false,
        tabLoading: false,
      }),
    ).toThrow(/Send is not available/);
  });

  it("throws when the tab is still busy instead of silent no-op success", () => {
    expect(() =>
      assertStopAndSendCanSend({
        hasActiveTab: true,
        hasRequest: true,
        hasSession: true,
        permissionPending: false,
        sendAvailable: true,
        tabBusy: true,
        tabLoading: false,
      }),
    ).toThrow(/still busy/);
  });

  it("allows a ready stop-and-send follow-up send", () => {
    expect(() =>
      assertStopAndSendCanSend({
        hasActiveTab: true,
        hasRequest: true,
        hasSession: true,
        permissionPending: false,
        sendAvailable: true,
        tabBusy: false,
        tabLoading: false,
      }),
    ).not.toThrow();
  });

  it("preserves the live continued draft typed while Stopping… after snapshot send", async () => {
    // Models the view wiring: capture continued draft, send snapshot, restore.
    let liveComposer = "next idea";
    const sent: string[] = [];
    const coordinator = new StopAndSendCoordinator(async (snapshotDraft, hooks) => {
      const continued = liveComposer;
      liveComposer = snapshotDraft; // temporary load for send
      sent.push(liveComposer);
      liveComposer = continuedDraftAfterStopAndSend(continued);
      hooks.onDispatched();
    });
    const barrier = deferredBarrier();
    coordinator.beginStop("snapshot at stop", barrier.barrier);
    // User keeps typing while Stopping…
    liveComposer = "next idea";
    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual(["snapshot at stop"]);
    expect(liveComposer).toBe("next idea");
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("restores continued draft at dispatch-started, not after the follow-up turn settles", async () => {
    expect(shouldRestoreContinuedDraftAt("dispatch-started")).toBe(true);
    expect(shouldRestoreContinuedDraftAt("turn-complete")).toBe(false);

    let releaseTurn!: () => void;
    const turnInFlight = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const observed: string[] = [];
    let sawDuringFlight: string | undefined;

    const handoff = runStopAndSendComposerHandoff({
      continuedDraft: "next idea",
      snapshotDraft: "snapshot at stop",
      turnInFlight,
      onComposerChange: (value) => {
        observed.push(value);
        // Capture the first non-empty restore while turn is still pending.
        if (value === "next idea" && sawDuringFlight === undefined) {
          sawDuringFlight = value;
        }
      },
    });

    // Yield so the handoff can run through restore before the turn settles.
    await Promise.resolve();
    await Promise.resolve();

    // While sendPrompt is still pending, composer must already show next idea.
    // Order: load snapshot → clear for outbound → restore continued draft.
    expect(observed).toEqual(["snapshot at stop", "", "next idea"]);
    expect(sawDuringFlight).toBe("next idea");
    // handoff must still be in-flight (turn not released) — proves restore
    // is not gated on turn completion.
    let settled = false;
    void handoff.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseTurn();
    const result = await handoff;
    expect(result.composerDuringTurn).toBe("next idea");
    expect(result.composerAfterTurn).toBe("next idea");
  });

  it("does not wipe typing that happens while the follow-up turn is in flight", async () => {
    let releaseTurn!: () => void;
    const turnInFlight = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let liveComposer = "next idea";

    const handoffPromise = runStopAndSendComposerHandoff({
      continuedDraft: liveComposer,
      snapshotDraft: "snapshot",
      turnInFlight,
      onComposerChange: (value) => {
        liveComposer = value;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    // Mid-flight: continued draft is already back in the composer.
    expect(liveComposer).toBe("next idea");
    // More typing during the new turn (after restore, before settle).
    liveComposer = "next idea plus more";
    releaseTurn();
    const result = await handoffPromise;
    expect(result.composerDuringTurn).toBe("next idea");
    // turn-complete must not clobber the extra typing with barrier-time draft.
    expect(liveComposer).toBe("next idea plus more");
    expect(result.composerAfterTurn).toBe("next idea");
  });

  it("leaves Stopping… / waiting at dispatch while follow-up sendPrompt is still pending", async () => {
    expect(isStopAndSendUiBlocking("stopping")).toBe(true);
    expect(isStopAndSendUiBlocking("waiting")).toBe(true);
    expect(isStopAndSendUiBlocking("idle")).toBe(false);
    expect(shouldCompleteStopAndSendCycleAt("dispatch-started")).toBe(true);
    expect(shouldCompleteStopAndSendCycleAt("turn-complete")).toBe(false);

    let releaseTurn!: () => void;
    const turnInFlight = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let liveComposer = "next idea";
    const phases: string[] = [];

    const coordinator = new StopAndSendCoordinator(async (snapshotDraft, hooks) => {
      // Mirror View sendMessage: load snapshot, clear, restore, dispatch mark,
      // THEN await sendPrompt — coordinator must already be idle mid-flight.
      liveComposer = snapshotDraft;
      liveComposer = "";
      liveComposer = continuedDraftAfterStopAndSend("next idea");
      hooks.onDispatched();
      phases.push(coordinator.getState().phase);
      expect(isStopAndSendUiBlocking(coordinator.getState().phase)).toBe(false);
      expect(liveComposer).toBe("next idea");
      await turnInFlight;
    });

    const barrier = deferredBarrier();
    coordinator.beginStop("snapshot at stop", barrier.barrier);
    expect(isStopAndSendUiBlocking(coordinator.getState().phase)).toBe(true);
    liveComposer = "next idea";
    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // While the follow-up turn is still pending, cycle is idle (normal running UI).
    expect(phases).toEqual(["idle"]);
    expect(coordinator.getState().phase).toBe("idle");
    expect(isStopAndSendUiBlocking(coordinator.getState().phase)).toBe(false);
    expect(coordinator.getState().snapshot).toBeUndefined();
    expect(liveComposer).toBe("next idea");
    // A new Stop can start (beginStop no longer no-ops on waiting).
    expect(() => coordinator.beginStop("can stop new turn", Promise.resolve())).not.toThrow();

    releaseTurn();
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getState().phase).toBe("idle");
  });

  it("pure cycle handoff leaves Stopping UI at dispatch-started only", async () => {
    let releaseTurn!: () => void;
    const turnInFlight = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let midPhase: string | undefined;
    let midStopping: boolean | undefined;

    const handoff = runStopAndSendCycleHandoff({
      continuedDraft: "next idea",
      snapshotDraft: "snapshot",
      turnInFlight,
      onPhase: (phase) => {
        if (phase === "idle" && midPhase === undefined) {
          midPhase = phase;
          midStopping = isStopAndSendUiBlocking(phase);
        }
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(midPhase).toBe("idle");
    expect(midStopping).toBe(false);

    let settled = false;
    void handoff.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseTurn();
    const result = await handoff;
    expect(result.phaseDuringTurn).toBe("idle");
    expect(result.stoppingDuringTurn).toBe(false);
    expect(result.composerDuringTurn).toBe("next idea");
    expect(result.phaseAfterTurn).toBe("idle");
  });

  it("marks send-failed and retains snapshot when fromStopAndSend guards throw", async () => {
    const send = vi.fn<StopAndSendSendFn>(async () => {
      assertStopAndSendCanSend({
        hasActiveTab: true,
        hasRequest: true,
        hasSession: true,
        permissionPending: false,
        sendAvailable: false,
        tabBusy: false,
        tabLoading: false,
      });
    });
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();
    coordinator.beginStop("must restore", barrier.barrier);
    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(coordinator.getState().phase).toBe("idle");
    expect(coordinator.getState().lastError).toMatch(/Send is not available/);
    expect(coordinator.getState().snapshot?.draft).toBe("must restore");
  });

  it("does not treat a silent no-op send as success (must throw to fail)", async () => {
    // Models the pre-fix bug: sendMessage returned without throwing while
    // busy/!send, and the coordinator marked send-succeeded + dropped snapshot.
    const send = vi.fn<StopAndSendSendFn>(async (_draft) => {
      // Silent return — wrong. Coordinator would clear snapshot.
    });
    const coordinator = new StopAndSendCoordinator(send);
    const barrier = deferredBarrier();
    coordinator.beginStop("must not be dropped", barrier.barrier);
    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Document the coordinator contract: a non-throwing send is success.
    // View must throw via assertStopAndSendCanSend instead of silent return.
    expect(coordinator.getState().phase).toBe("idle");
    expect(coordinator.getState().snapshot).toBeUndefined();
    expect(coordinator.getState().lastError).toBeUndefined();

    // Correct path: guard throw → snapshot retained.
    const guarded = vi.fn<StopAndSendSendFn>(async () => {
      assertStopAndSendCanSend({
        hasActiveTab: true,
        hasRequest: true,
        hasSession: true,
        permissionPending: false,
        sendAvailable: true,
        tabBusy: true,
        tabLoading: false,
      });
    });
    const c2 = new StopAndSendCoordinator(guarded);
    const b2 = deferredBarrier();
    c2.beginStop("must not be dropped", b2.barrier);
    b2.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(c2.getState().snapshot?.draft).toBe("must not be dropped");
    expect(c2.getState().lastError).toMatch(/still busy/);
  });

  it("does not restore snapshot on post-dispatch send failure (normal turn owns error)", async () => {
    let releaseTurn!: () => void;
    const turnInFlight = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const coordinator = new StopAndSendCoordinator(async (_draft, hooks) => {
      hooks.onDispatched();
      await turnInFlight;
      throw new Error("follow-up turn failed after dispatch");
    });
    const barrier = deferredBarrier();
    coordinator.beginStop("already on wire", barrier.barrier);
    barrier.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Already idle + snapshot cleared at dispatch.
    expect(coordinator.getState().phase).toBe("idle");
    expect(coordinator.getState().snapshot).toBeUndefined();
    expect(isStopAndSendUiBlocking(coordinator.getState().phase)).toBe(false);

    releaseTurn();
    await Promise.resolve();
    await Promise.resolve();
    // Post-dispatch failure must not re-enter send-failed / re-arm snapshot.
    expect(coordinator.getState().phase).toBe("idle");
    expect(coordinator.getState().snapshot).toBeUndefined();
    expect(coordinator.getState().lastError).toBeUndefined();
  });
});

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
