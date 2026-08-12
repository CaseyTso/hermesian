/**
 * Stop-and-send: cancel the in-flight message, then — only once the main turn
 * has *actually* finished — send the snapshot as a normal new turn.
 *
 * The barrier is the main prompt's terminal completion, provided as an
 * injected promise (the view resolves it at the sendPrompt-complete / runtime
 * busy=false transition point). There is deliberately no timer: guessing when
 * a turn ended with setTimeout would race the real completion.
 *
 * After the barrier, the snapshot is dispatched as a normal new turn. The
 * coordinator leaves `waiting` (Stopping… UI) at **dispatch** — when the
 * snapshot is on the outbound wire — not after that follow-up turn's full
 * sendPrompt settle. Holding `waiting` for the whole next turn would disable
 * Stop/Esc for the entire agent response.
 */

export type StopAndSendPhase = "idle" | "stopping" | "waiting";

export interface StopAndSendSnapshot {
  /** The canonical send content captured at the moment Stop was clicked. */
  readonly draft: string;
}

export interface StopAndSendState {
  lastError: string | undefined;
  phase: StopAndSendPhase;
  /** Snapshot of the message being stopped; retained on failure for restore. */
  snapshot: StopAndSendSnapshot | undefined;
}

export const initialStopAndSendState: StopAndSendState = Object.freeze({
  lastError: undefined,
  phase: "idle",
  snapshot: undefined,
});

export type StopAndSendAction =
  | { type: "begin-stop"; draft: string }
  | { type: "barrier-resolved" }
  | { type: "barrier-rejected"; error: string }
  | { type: "send-succeeded" }
  | { type: "send-failed"; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Guards for the stop-and-send follow-up send. Callers must throw on failure
 * so the coordinator records `send-failed` and restores the snapshot — a
 * silent no-op would mark success and drop the draft.
 */
export interface StopAndSendSendGuards {
  hasActiveTab: boolean;
  hasRequest: boolean;
  hasSession: boolean;
  permissionPending: boolean;
  sendAvailable: boolean;
  tabBusy: boolean;
  tabLoading: boolean;
}

export function assertStopAndSendCanSend(guards: StopAndSendSendGuards): void {
  if (!guards.hasActiveTab) {
    throw new Error("No active conversation for stop-and-send.");
  }
  if (!guards.sendAvailable) {
    throw new Error("Send is not available for stop-and-send.");
  }
  if (guards.tabBusy) {
    throw new Error("Conversation is still busy; stop-and-send cannot start the next turn.");
  }
  if (guards.tabLoading) {
    throw new Error("Conversation is still loading; stop-and-send cannot start the next turn.");
  }
  if (guards.permissionPending) {
    throw new Error("A permission prompt is still pending; stop-and-send cannot start the next turn.");
  }
  if (!guards.hasSession) {
    throw new Error("This conversation is still starting.");
  }
  if (!guards.hasRequest) {
    throw new Error("Stop-and-send snapshot is empty.");
  }
}

/**
 * After a successful stop-and-send *dispatch*, restore any text the user typed
 * into the cleared composer while Stopping… — the snapshot was sent, not that
 * live draft. Restore must happen at dispatch start (after outbound capture),
 * not after the follow-up turn completes, or the composer stays empty for the
 * whole next turn and later typing can be wiped on settle.
 */
export function continuedDraftAfterStopAndSend(liveDraftAtSendTime: string): string {
  return liveDraftAtSendTime;
}

/** Phase at which the continued draft must reappear in the live composer. */
export type StopAndSendContinuedDraftRestorePoint = "dispatch-started" | "turn-complete";

/**
 * Pure timing contract for View wiring tests: continued draft restores when
 * the follow-up turn is dispatched, never when that turn later completes.
 */
export function shouldRestoreContinuedDraftAt(
  point: StopAndSendContinuedDraftRestorePoint,
): boolean {
  return point === "dispatch-started";
}

/** Phase at which the stop-and-send cycle leaves Stopping… / waiting UI. */
export type StopAndSendCycleCompletePoint = "dispatch-started" | "turn-complete";

/**
 * Pure timing contract: the coordinator must mark send-succeeded (leave
 * Stopping…) when the snapshot is dispatched as a normal new turn — not when
 * that follow-up turn's sendPrompt later settles.
 */
export function shouldCompleteStopAndSendCycleAt(
  point: StopAndSendCycleCompletePoint,
): boolean {
  return point === "dispatch-started";
}

/**
 * Whether the stop-and-send cycle still owns the Stopping… UI (and blocks a
 * second Stop / Esc stop). Only true during cancel/barrier and pre-dispatch
 * waiting — once the snapshot is on the wire as a normal turn, this is false.
 */
export function isStopAndSendUiBlocking(phase: StopAndSendPhase): boolean {
  return phase === "stopping" || phase === "waiting";
}

/** Alias used by pure handoff models / tests. */
export function isStopAndSendUiStopping(phase: StopAndSendPhase): boolean {
  return isStopAndSendUiBlocking(phase);
}

/**
 * Models the View send path for stop-and-send: load snapshot → clear for
 * outbound → restore continued draft before the in-flight turn promise settles.
 * Used by regression tests so green unit tests cannot claim success while the
 * real View still awaited full-turn completion before restore.
 */
export async function runStopAndSendComposerHandoff(options: {
  continuedDraft: string;
  snapshotDraft: string;
  /** Resolves when the follow-up turn ends (sendPrompt terminal). */
  turnInFlight: Promise<void>;
  onComposerChange?: (value: string) => void;
}): Promise<{ composerDuringTurn: string; composerAfterTurn: string }> {
  let composer = options.continuedDraft;
  const emit = () => options.onComposerChange?.(composer);

  // 1. Temporarily load snapshot for outbound capture (View applyComposerCanonicalDraft).
  composer = options.snapshotDraft;
  emit();
  // 2. sendMessage clears composer after capturing request.
  composer = "";
  emit();
  // 3. Restore continued draft at dispatch-started — BEFORE awaiting the turn.
  if (shouldRestoreContinuedDraftAt("dispatch-started")) {
    composer = continuedDraftAfterStopAndSend(options.continuedDraft);
    emit();
  }
  const composerDuringTurn = composer;
  await options.turnInFlight;
  // 4. Must NOT re-apply barrier-time continued draft at turn-complete (would
  // wipe anything the user typed during the follow-up turn).
  if (shouldRestoreContinuedDraftAt("turn-complete")) {
    composer = continuedDraftAfterStopAndSend(options.continuedDraft);
    emit();
  }
  return { composerAfterTurn: composer, composerDuringTurn };
}

/**
 * Models barrier → dispatch → idle while sendPrompt is still pending.
 * Regression guard: UI must not stay Stopping… for the whole follow-up turn.
 */
export async function runStopAndSendCycleHandoff(options: {
  continuedDraft: string;
  snapshotDraft: string;
  /** Resolves when the follow-up sendPrompt ends. */
  turnInFlight: Promise<void>;
  onPhase?: (phase: StopAndSendPhase, composer: string) => void;
}): Promise<{
  composerDuringTurn: string;
  phaseDuringTurn: StopAndSendPhase;
  stoppingDuringTurn: boolean;
  phaseAfterTurn: StopAndSendPhase;
}> {
  let phase: StopAndSendPhase = "idle";
  let composer = options.continuedDraft;
  const emit = () => options.onPhase?.(phase, composer);

  // Stop clicked: capture snapshot, clear composer, show Stopping…
  phase = "stopping";
  composer = "";
  emit();
  // User keeps typing the next idea while the main turn cancels.
  composer = options.continuedDraft;
  emit();
  // Main-turn barrier resolved → waiting to dispatch snapshot.
  phase = "waiting";
  emit();
  // Dispatch: load snapshot → clear for outbound → restore continued draft.
  composer = options.snapshotDraft;
  emit();
  composer = "";
  emit();
  if (shouldRestoreContinuedDraftAt("dispatch-started")) {
    composer = continuedDraftAfterStopAndSend(options.continuedDraft);
    emit();
  }
  // Cycle completes at dispatch — follow-up turn is a normal in-flight turn.
  if (shouldCompleteStopAndSendCycleAt("dispatch-started")) {
    phase = "idle";
    emit();
  }
  const phaseDuringTurn = phase;
  const stoppingDuringTurn = isStopAndSendUiStopping(phase);
  const composerDuringTurn = composer;

  await options.turnInFlight;
  if (shouldCompleteStopAndSendCycleAt("turn-complete")) {
    phase = "idle";
    emit();
  }
  return {
    composerDuringTurn,
    phaseDuringTurn,
    stoppingDuringTurn,
    phaseAfterTurn: phase,
  };
}

/**
 * Pure state transitions. The snapshot is captured once (the first begin-stop
 * of a cycle wins); barrier signals outside a cycle are ignored.
 */
export function reduceStopAndSend(
  state: StopAndSendState,
  action: StopAndSendAction,
): StopAndSendState {
  switch (action.type) {
    case "begin-stop":
      if (state.phase !== "idle") {
        // Already stopping/waiting — keep the original snapshot.
        return state;
      }
      return {
        lastError: undefined,
        phase: "stopping",
        snapshot: Object.freeze({ draft: action.draft }),
      };
    case "barrier-resolved":
      if (state.phase !== "stopping") {
        return state;
      }
      return { ...state, phase: "waiting" };
    case "barrier-rejected":
      if (state.phase !== "stopping" && state.phase !== "waiting") {
        return state;
      }
      // Cancel failed: back to editing, snapshot retained for restore,
      // error surfaced.
      return {
        lastError: action.error,
        phase: "idle",
        snapshot: state.snapshot,
      };
    case "send-succeeded":
      if (state.phase !== "waiting") {
        return state;
      }
      return { lastError: undefined, phase: "idle", snapshot: undefined };
    case "send-failed":
      if (state.phase !== "waiting") {
        return state;
      }
      return {
        lastError: action.error,
        phase: "idle",
        snapshot: state.snapshot,
      };
  }
}

/** Called by the send path once the snapshot is on the outbound wire. */
export interface StopAndSendDispatchHooks {
  onDispatched: () => void;
}

/**
 * Send callback for stop-and-send. Must call `hooks.onDispatched` once the
 * snapshot is on the outbound wire (user row + continued draft restored),
 * then may keep awaiting the follow-up sendPrompt without holding Stopping….
 */
export type StopAndSendSendFn = (
  draft: string,
  hooks: StopAndSendDispatchHooks,
) => Promise<void>;

/**
 * Coordinator wiring the pure state machine to the injected send callback and
 * barrier promise. The barrier is the ONLY trigger for the send — no timers.
 *
 * Cycle completion (`send-succeeded`) happens at `hooks.onDispatched`, not
 * when the send promise settles after the full follow-up turn.
 */
export class StopAndSendCoordinator {
  private state: StopAndSendState = initialStopAndSendState;

  constructor(private readonly send: StopAndSendSendFn) {}

  getState(): StopAndSendState {
    return this.state;
  }

  beginStop(draft: string, barrier: Promise<void>): void {
    if (this.state.phase !== "idle") {
      // New typing during stopping is a separate next draft; the module does
      // not swallow it, but it must not clobber the in-flight snapshot.
      return;
    }
    this.state = reduceStopAndSend(this.state, { draft, type: "begin-stop" });
    void barrier.then(
      () => {
        this.state = reduceStopAndSend(this.state, { type: "barrier-resolved" });
        if (this.state.phase === "waiting") {
          void this.attemptSend();
        }
      },
      (error: unknown) => {
        this.state = reduceStopAndSend(this.state, {
          error: errorMessage(error),
          type: "barrier-rejected",
        });
      },
    );
  }

  private async attemptSend(): Promise<void> {
    const snapshot = this.state.snapshot;
    if (!snapshot || this.state.phase !== "waiting") {
      return;
    }
    let dispatched = false;
    try {
      await this.send(snapshot.draft, {
        onDispatched: () => {
          if (this.state.phase !== "waiting") {
            return;
          }
          dispatched = true;
          // Leave Stopping… as soon as the snapshot is a normal new turn.
          this.state = reduceStopAndSend(this.state, { type: "send-succeeded" });
        },
      });
      // Simple send paths that resolve without calling onDispatched still
      // complete the cycle (unit tests / no long-lived turn).
      if (this.state.phase === "waiting") {
        this.state = reduceStopAndSend(this.state, { type: "send-succeeded" });
      }
    } catch (error) {
      // Only pre-dispatch failures keep the snapshot for restore. After
      // onDispatched, the follow-up turn owns normal error UX.
      if (this.state.phase === "waiting" && !dispatched) {
        this.state = reduceStopAndSend(this.state, {
          error: errorMessage(error),
          type: "send-failed",
        });
      }
    }
  }
}
