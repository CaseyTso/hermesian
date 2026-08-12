export class MessageRenderer {
  readonly #caches = new Map<string, HTMLElement>();
  readonly #document: Document;
  readonly #messagesEl: HTMLElement;
  #visibleTabId: string | undefined;

  constructor(messagesEl: HTMLElement) {
    this.#messagesEl = messagesEl;
    this.#document = messagesEl.ownerDocument;
  }

  /** Returns the DOM container where messages for `tabId` should be inserted. */
  containerFor(tabId: string): HTMLElement {
    if (this.#visibleTabId === tabId) {
      return this.#messagesEl;
    }
    let cache = this.#caches.get(tabId);
    if (!cache) {
      cache = this.#document.createElement("div");
      this.#caches.set(tabId, cache);
    }
    return cache;
  }

  /** Swaps the visible messages to show `tabId` content. */
  show(tabId: string): void {
    if (!this.#visibleTabId) {
      this.#visibleTabId = tabId;
      return;
    }
    if (this.#visibleTabId === tabId) {
      return;
    }

    const currentCache = this.#getOrCreateCache(this.#visibleTabId);
    currentCache.replaceChildren(...Array.from(this.#messagesEl.childNodes));

    const targetCache = this.#getOrCreateCache(tabId);
    this.#messagesEl.replaceChildren(...Array.from(targetCache.childNodes));

    this.#visibleTabId = tabId;
    this.scrollToBottom();
  }

  /** Discards the cached messages for `tabId`. */
  forget(tabId: string): void {
    this.#caches.delete(tabId);
  }

  /** Returns true when `tabId` messages are currently displayed. */
  isVisible(tabId: string): boolean {
    return this.#visibleTabId === tabId;
  }

  /** Clears all messages currently shown in the messagesEl. */
  clearVisible(): void {
    this.#messagesEl.empty();
  }

  /** Schedules a scroll-to-bottom via requestAnimationFrame. */
  scrollToBottom(sourceTabId?: string): void {
    window.requestAnimationFrame(() => {
      if (sourceTabId !== undefined && this.#visibleTabId !== sourceTabId) {
        return;
      }
      this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
    });
  }

  #getOrCreateCache(tabId: string): HTMLElement {
    let cache = this.#caches.get(tabId);
    if (!cache) {
      cache = this.#document.createElement("div");
      this.#caches.set(tabId, cache);
    }
    return cache;
  }
}

// ── Turn Manager ──────────────────────────────────────────────

export interface TurnRuntime {
  activeTurnEl?: HTMLElement;
  assistantContentEl?: HTMLElement;
  assistantText: string;
  busy: boolean;
  completionPromise?: Promise<void>;
  thoughtContentEl?: HTMLElement;
  toolEls: Map<string, HTMLElement>;
  turnActivityEl?: HTMLElement;
}

export interface TurnCallbacks {
  /** Called after every turn completes (success or failure). */
  onTurnComplete(tabId: string): void;
}

type IdleWaiter = {
  reject: (error: unknown) => void;
  resolve: () => void;
};

export class TurnManager {
  readonly #renderer: MessageRenderer;
  readonly #runtimes = new Map<string, TurnRuntime>();
  /** One-shot waiters parked until a busy tab becomes idle via real completion. */
  readonly #idleWaiters = new Map<string, IdleWaiter[]>();
  #callbacks?: TurnCallbacks;

  constructor(renderer: MessageRenderer, callbacks?: TurnCallbacks) {
    this.#renderer = renderer;
    this.#callbacks = callbacks;
  }

  setCallbacks(callbacks: TurnCallbacks): void {
    this.#callbacks = callbacks;
  }

  /** Gets or creates the turn runtime for a tab. */
  ensure(tabId: string): TurnRuntime {
    let runtime = this.#runtimes.get(tabId);
    if (!runtime) {
      runtime = {
        assistantText: "",
        busy: false,
        toolEls: new Map<string, HTMLElement>(),
      };
      this.#runtimes.set(tabId, runtime);
    }
    return runtime;
  }

  /** Returns true if a turn is actively streaming for this tab. */
  isBusy(tabId: string): boolean {
    return this.#runtimes.get(tabId)?.busy === true;
  }

  /**
   * Resolves when the tab's main turn is idle: not busy and no in-flight
   * completionPromise. Subscribes to real TurnManager.complete transitions —
   * never microtask-polls or wall-clock guesses.
   */
  waitUntilIdle(tabId: string): Promise<void> {
    const runtime = this.ensure(tabId);
    if (!runtime.busy && !runtime.completionPromise) {
      return Promise.resolve();
    }
    // Park until complete() clears busy + completionPromise and wakes waiters.
    // Do not attach .then to completionPromise here: a settled promise would
    // re-enter waitUntilIdle while completionPromise is still assigned and loop.
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#idleWaiters.get(tabId) ?? [];
      waiters.push({ reject, resolve });
      this.#idleWaiters.set(tabId, waiters);
    });
  }

  #resolveIdleWaiters(tabId: string): void {
    const runtime = this.#runtimes.get(tabId);
    if (runtime?.busy || runtime?.completionPromise) {
      return;
    }
    const waiters = this.#idleWaiters.get(tabId);
    if (!waiters?.length) {
      return;
    }
    this.#idleWaiters.delete(tabId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /** Creates the turn DOM scaffold if it doesn't exist. Returns the activity container. */
  ensureActivity(tabId: string): HTMLElement {
    const runtime = this.ensure(tabId);
    if (!runtime.activeTurnEl) {
      runtime.activeTurnEl = this.#renderer.containerFor(tabId).createDiv({
        cls: "hermesian-turn",
      });
    }
    if (!runtime.turnActivityEl) {
      runtime.turnActivityEl = runtime.activeTurnEl.createDiv({
        cls: "hermesian-turn-activity",
      });
    }
    return runtime.turnActivityEl;
  }

  /** Appends a streaming assistant text delta. */
  appendDelta(tabId: string, text: string): void {
    const runtime = this.ensure(tabId);
    this.ensureActivity(tabId);
    if (!runtime.assistantContentEl) {
      const message = runtime.activeTurnEl!.createDiv({
        cls: "hermesian-message is-assistant",
      });
      runtime.assistantContentEl = message.createDiv({
        cls: "hermesian-message-content is-streaming",
      });
    }
    runtime.assistantText += text;
    runtime.assistantContentEl.setText(runtime.assistantText);
  }

  /** Appends a streaming thought delta. */
  appendThought(tabId: string, text: string): void {
    const runtime = this.ensure(tabId);
    if (!runtime.thoughtContentEl) {
      const details = this.ensureActivity(tabId).createEl("details", {
        cls: "hermesian-thought",
      });
      details.open = true;
      details.createEl("summary", { text: "Thinking" });
      runtime.thoughtContentEl = details.createEl("pre");
    }
    runtime.thoughtContentEl.textContent =
      `${runtime.thoughtContentEl.textContent ?? ""}${text}`;
  }

  /** Resets streaming-only state for a new turn. */
  resetStreaming(tabId: string): void {
    const runtime = this.ensure(tabId);
    runtime.assistantContentEl = undefined;
    runtime.assistantText = "";
    runtime.thoughtContentEl = undefined;
  }

  /** Clears all messages and streaming state for a tab. */
  resetView(tabId: string): void {
    this.#renderer.containerFor(tabId).empty();
    const runtime = this.ensure(tabId);
    runtime.toolEls.clear();
    this.resetStreaming(tabId);
    runtime.activeTurnEl = undefined;
    runtime.turnActivityEl = undefined;
  }

  /** Removes the runtime for a tab. */
  delete(tabId: string): void {
    this.#runtimes.delete(tabId);
  }

  /**
   * Deduplicates turn completion: ensures `finalize()` runs at most once.
   * Returns the shared completion promise.
   */
  complete(tabId: string, finalize: () => Promise<void>): Promise<void> {
    const runtime = this.ensure(tabId);
    if (runtime.completionPromise) {
      return runtime.completionPromise;
    }
    const completion = this.#completeInternal(tabId, runtime, finalize);
    runtime.completionPromise = completion;
    void completion.finally(() => {
      if (runtime.completionPromise === completion) {
        runtime.completionPromise = undefined;
      }
      // Wake waitUntilIdle parkers only after busy is false and the promise
      // slot is cleared — real terminal completion, no polling.
      this.#resolveIdleWaiters(tabId);
    });
    return completion;
  }

  async #completeInternal(
    tabId: string,
    runtime: TurnRuntime,
    finalize: () => Promise<void>,
  ): Promise<void> {
    try {
      await finalize();
    } finally {
      runtime.busy = false;
      runtime.activeTurnEl = undefined;
      runtime.turnActivityEl = undefined;
      runtime.thoughtContentEl = undefined;
      this.#callbacks?.onTurnComplete(tabId);
    }
  }
}
