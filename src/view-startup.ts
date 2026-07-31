export type ViewStartupPhase =
  | "idle"
  | "awaiting-layout"
  | "initializing"
  | "ready"
  | "failed"
  | "closed";

export type ViewStartupStatus = "connecting" | "ready" | "error" | "disconnected";

export interface ViewStartupHost {
  isLayoutReady(): boolean;
  whenLayoutReady(callback: () => void): void;
  startInitialization(): Promise<void>;
  onFailure(error: unknown): void;
  onStatus(status: ViewStartupStatus, detail?: string): void;
}

/**
 * Decouples Obsidian view open/close from Hermes ACP initialization.
 * `begin()` must return immediately; actual connect waits for layout-ready
 * and runs in the background with a generation token so late results after
 * close are ignored.
 */
export class ViewStartupCoordinator {
  private closed = false;
  private generation = 0;
  private phase: ViewStartupPhase = "idle";
  private started = false;
  private layoutHooked = false;

  constructor(private readonly host: ViewStartupHost) {}

  getPhase(): ViewStartupPhase {
    return this.phase;
  }

  getGeneration(): number {
    return this.generation;
  }

  isClosed(): boolean {
    return this.closed;
  }

  begin(): void {
    if (
      this.closed ||
      this.started ||
      this.phase === "initializing" ||
      this.phase === "ready"
    ) {
      return;
    }
    if (this.phase === "failed") {
      return;
    }
    this.phase = "awaiting-layout";
    this.armLayout();
  }

  retry(): void {
    if (this.closed) {
      return;
    }
    this.started = false;
    this.phase = "awaiting-layout";
    this.armLayout(true);
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.phase = "closed";
  }

  private armLayout(force = false): void {
    if (this.closed) {
      return;
    }
    if (this.layoutHooked && !force) {
      if (this.host.isLayoutReady()) {
        this.queueStart();
      }
      return;
    }
    this.layoutHooked = true;
    if (this.host.isLayoutReady()) {
      this.queueStart();
      return;
    }
    this.host.whenLayoutReady(() => {
      this.queueStart();
    });
  }

  private queueStart(): void {
    if (this.closed || this.started) {
      return;
    }
    this.started = true;
    // Defer so begin()/layout callback never awaits initialize.
    void Promise.resolve()
      .then(() => this.runInitialization())
      .catch(() => {
        // runInitialization already reports failures via onFailure
      });
  }

  private async runInitialization(): Promise<void> {
    if (this.closed) {
      return;
    }
    const generation = ++this.generation;
    this.phase = "initializing";
    this.host.onStatus("connecting");
    try {
      await this.host.startInitialization();
      if (this.closed || generation !== this.generation) {
        return;
      }
      this.phase = "ready";
      this.host.onStatus("ready");
    } catch (error) {
      if (this.closed || generation !== this.generation) {
        return;
      }
      this.phase = "failed";
      this.started = false;
      const detail = error instanceof Error ? error.message : String(error);
      this.host.onStatus("error", detail);
      this.host.onFailure(error);
    }
  }
}
