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

    // Preserve current visible content in its cache
    const currentCache = this.#getOrCreateCache(this.#visibleTabId);
    currentCache.replaceChildren(...Array.from(this.#messagesEl.childNodes));

    // Load target content into messagesEl
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
