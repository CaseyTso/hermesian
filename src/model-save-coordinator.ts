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
 * Serializes candidate persistence with generation-based ownership.
 *
 * Only the newest requested candidate is authoritative:
 * - candidates that have not started saving are coalesced away;
 * - a stale save that fails after a newer request arrived neither rolls back
 *   memory nor reports failure (the newer candidate persists next);
 * - a stale save that succeeds is followed by a re-persist of the newest
 *   candidate, so the disk always ends at the latest request.
 * The queue swallows per-run errors so a failed save never wedges later ones.
 */
export class ModelSaveCoordinator {
  private readonly applyMemory: (value: string[]) => void;
  private readonly persist: (value: string[]) => Promise<void>;
  private readonly onError: ((error: unknown) => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private pending: string[] | null = null;
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
    this.pending = null;
    this.generation += 1;
  }

  save(candidate: string[]): Promise<void> {
    const value = normalizeHiddenSwitchIds(candidate);
    const gen = ++this.generation;
    this.pending = value;
    const run = this.chain.then(() => this.flush(gen));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flush(gen: number): Promise<void> {
    const value = this.pending;
    this.pending = null;
    if (value === null) {
      // A newer task already consumed the pending candidate.
      return;
    }
    try {
      this.applyMemory(value);
      await this.persist(value);
      this.committed = value;
    } catch (error) {
      if (gen === this.generation) {
        // This candidate is still the newest request: roll back to the last
        // successfully persisted value and surface the failure.
        this.applyMemory(this.committed);
        this.onError?.(error);
        throw error;
      }
      // A stale candidate failed after a newer request was queued: stay
      // silent — the newer candidate will persist next.
    }
  }
}
