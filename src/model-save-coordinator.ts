import { normalizeHiddenSwitchIds } from "./ui/model-picker-popover";

export interface ModelSaveCoordinatorOptions {
  /**
   * Baseline value (the most recently persisted state at construction time).
   * Normalized internally; only the normalized copy is kept.
   */
  initial: string[];
  /** Applies the candidate to in-memory settings before persisting. */
  applyMemory: (value: string[]) => void;
  /** Performs the real disk write for the given candidate. */
  persist: (value: string[]) => Promise<void>;
  /** Invoked when the *newest* candidate fails to persist. */
  onError?: (error: unknown) => void;
}

/**
 * Serializes candidate persistence with per-candidate ownership.
 *
 * Every `save()` captures its own immutable `{ value, generation }` task and
 * executes it in queue order; there is no shared pending slot, so error
 * attribution is unambiguous:
 * - a successful candidate immediately becomes `committed`;
 * - a failure of the *current newest* candidate rolls memory back to the last
 *   successful candidate, reports through `onError` and rejects the caller;
 * - a failure of a stale candidate (a newer request already exists) stays
 *   silent and fulfills, because the newer task will persist next.
 * The queue swallows per-task errors only to keep the chain alive; each
 * caller still receives its own task's outcome.
 */
export class ModelSaveCoordinator {
  private readonly applyMemory: (value: string[]) => void;
  private readonly persist: (value: string[]) => Promise<void>;
  private readonly onError: ((error: unknown) => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private committed: string[];
  private generation = 0;

  constructor(options: ModelSaveCoordinatorOptions) {
    this.applyMemory = options.applyMemory;
    this.persist = options.persist;
    this.onError = options.onError;
    this.committed = normalizeHiddenSwitchIds(options.initial);
  }

  /**
   * Re-baselines the committed value, e.g. after plugin data was loaded at
   * startup. Safe to call only while no save is in flight (startup path).
   */
  reset(initial: string[]): void {
    this.committed = normalizeHiddenSwitchIds(initial);
    this.generation += 1;
  }

  save(candidate: string[]): Promise<void> {
    const task = {
      value: normalizeHiddenSwitchIds(candidate),
      generation: ++this.generation,
    };
    const run = this.chain.then(() => this.flush(task));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flush(task: { value: string[]; generation: number }): Promise<void> {
    try {
      this.applyMemory(task.value);
      await this.persist(task.value);
      this.committed = task.value;
    } catch (error) {
      if (task.generation === this.generation) {
        // This task is still the newest request: roll back to the last
        // successfully persisted value and surface the failure.
        this.applyMemory(this.committed);
        this.onError?.(error);
        throw error;
      }
      // A stale candidate failed after a newer request was queued: stay
      // silent — the newer task will persist next.
    }
  }
}
