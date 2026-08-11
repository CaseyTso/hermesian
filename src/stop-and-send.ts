/**
 * Stop-and-send: cancel the in-flight message, then — only once the main turn
 * has *actually* finished — send the snapshot as a normal new turn.
 *
 * The barrier is the main prompt's terminal completion, provided as an
 * injected promise (the view resolves it at the sendPrompt-complete / runtime
 * busy=false transition point). There is deliberately no timer: guessing when
 * a turn ended with setTimeout would race the real completion.
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

/**
 * Coordinator wiring the pure state machine to the injected send callback and
 * barrier promise. The barrier is the ONLY trigger for the send — no timers.
 */
export class StopAndSendCoordinator {
  private state: StopAndSendState = initialStopAndSendState;

  constructor(private readonly send: (draft: string) => Promise<void>) {}

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
    try {
      await this.send(snapshot.draft);
      this.state = reduceStopAndSend(this.state, { type: "send-succeeded" });
    } catch (error) {
      this.state = reduceStopAndSend(this.state, {
        error: errorMessage(error),
        type: "send-failed",
      });
    }
  }
}
