import type { ScrollFollowController } from "./scroll-lock";
import { readScrollGeometry } from "./scroll-lock";

export interface MessageRendererOptions {
  /** Optional per-tab auto-follow lock. When set, scrollToBottom respects it. */
  scrollFollow?: ScrollFollowController;
}

export interface ScrollToBottomOptions {
  /**
   * Force scroll to bottom and unlock follow for the source/visible tab.
   * Used when the user sends a new message (intent: jump to latest).
   */
  force?: boolean;
}

export class MessageRenderer {
  readonly #caches = new Map<string, HTMLElement>();
  readonly #document: Document;
  readonly #messagesEl: HTMLElement;
  readonly #scrollFollow?: ScrollFollowController;
  /** Last user/programmatic scrollTop per tab — restored when revisiting a locked tab. */
  readonly #scrollTopByTab = new Map<string, number>();
  /** True while we programmatically set scrollTop so the scroll listener ignores it. */
  #programmaticScroll = false;
  #visibleTabId: string | undefined;

  constructor(messagesEl: HTMLElement, options: MessageRendererOptions = {}) {
    this.#messagesEl = messagesEl;
    this.#document = messagesEl.ownerDocument;
    this.#scrollFollow = options.scrollFollow;
    if (this.#scrollFollow) {
      this.#messagesEl.addEventListener("scroll", () => {
        this.#onUserScroll();
      }, { passive: true });
    }
  }

  /** Expose follow controller for view/send paths that need explicit unlock. */
  get scrollFollow(): ScrollFollowController | undefined {
    return this.#scrollFollow;
  }

  #onUserScroll(): void {
    if (this.#programmaticScroll || !this.#scrollFollow || !this.#visibleTabId) {
      return;
    }
    this.#scrollTopByTab.set(this.#visibleTabId, this.#messagesEl.scrollTop);
    this.#scrollFollow.syncFromGeometry(
      this.#visibleTabId,
      readScrollGeometry(this.#messagesEl),
    );
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

    // Preserve outgoing tab scroll so a locked tab can restore mid-history position.
    this.#scrollTopByTab.set(this.#visibleTabId, this.#messagesEl.scrollTop);

    const currentCache = this.#getOrCreateCache(this.#visibleTabId);
    currentCache.replaceChildren(...Array.from(this.#messagesEl.childNodes));

    const targetCache = this.#getOrCreateCache(tabId);
    this.#messagesEl.replaceChildren(...Array.from(targetCache.childNodes));

    this.#visibleTabId = tabId;
    if (this.#scrollFollow?.isLocked(tabId)) {
      this.#setScrollTop(this.#scrollTopByTab.get(tabId) ?? 0);
      return;
    }
    this.scrollToBottom(tabId);
  }

  /** Discards the cached messages for `tabId`. */
  forget(tabId: string): void {
    this.#caches.delete(tabId);
    this.#scrollTopByTab.delete(tabId);
    this.#scrollFollow?.forget(tabId);
  }

  /** Returns true when `tabId` messages are currently displayed. */
  isVisible(tabId: string): boolean {
    return this.#visibleTabId === tabId;
  }

  /** Clears all messages currently shown in the messagesEl. */
  clearVisible(): void {
    this.#messagesEl.empty();
  }

  /**
   * Schedules a scroll-to-bottom via requestAnimationFrame.
   * When a ScrollFollowController is attached, skips auto-scroll while the
   * relevant tab is locked (user scrolled away). Pass `{ force: true }` to
   * unlock and jump (e.g. user sent a new message).
   */
  scrollToBottom(sourceTabId?: string, options: ScrollToBottomOptions = {}): void {
    window.requestAnimationFrame(() => {
      if (sourceTabId !== undefined && this.#visibleTabId !== sourceTabId) {
        return;
      }
      const followTabId = sourceTabId ?? this.#visibleTabId;
      if (this.#scrollFollow && followTabId !== undefined) {
        if (options.force) {
          this.#scrollFollow.unlock(followTabId);
        } else if (!this.#scrollFollow.shouldAutoScroll(this.#visibleTabId, sourceTabId)) {
          return;
        }
      }
      this.#setScrollTop(this.#messagesEl.scrollHeight);
      if (followTabId !== undefined) {
        this.#scrollTopByTab.set(followTabId, this.#messagesEl.scrollTop);
      }
    });
  }

  #setScrollTop(value: number): void {
    this.#programmaticScroll = true;
    this.#messagesEl.scrollTop = value;
    // Re-enable user-scroll tracking after the browser delivers any synthetic scroll.
    window.requestAnimationFrame(() => {
      this.#programmaticScroll = false;
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
  thoughtDetailsEl?: HTMLDetailsElement;
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
      // Close the TOCTOU window: complete() may have finished between the
      // busy check above and this park. Re-check without polling.
      this.#resolveIdleWaiters(tabId);
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
      }) as HTMLDetailsElement;
      details.open = true;
      details.createEl("summary", { text: "Thinking" });
      runtime.thoughtDetailsEl = details;
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
    runtime.thoughtDetailsEl = undefined;
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
    // Tab gone: any parked stop-and-send barrier must not hang forever.
    const waiters = this.#idleWaiters.get(tabId);
    if (waiters?.length) {
      this.#idleWaiters.delete(tabId);
      const error = new Error(`Turn runtime deleted for ${tabId}`);
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
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
      if (runtime.thoughtDetailsEl) {
        runtime.thoughtDetailsEl.open = false;
      }
      await finalize();
    } finally {
      runtime.busy = false;
      runtime.activeTurnEl = undefined;
      runtime.turnActivityEl = undefined;
      runtime.thoughtContentEl = undefined;
      runtime.thoughtDetailsEl = undefined;
      this.#callbacks?.onTurnComplete(tabId);
    }
  }
}
