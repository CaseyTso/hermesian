import { setIcon } from "obsidian";
import type { ScrollFollowController } from "./scroll-lock";
import {
  DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX,
  distanceFromBottom,
  readScrollGeometry,
} from "./scroll-lock";

export const DEFAULT_DOT_PITCH_PX = 14;
export const MAX_PREVIEW_CHARS = 40;
export const SCROLL_THROTTLE_MS = 100;

export interface TurnRecord {
  id: string;
  userMessageEl: HTMLElement;
  turnEl?: HTMLElement;
  text: string;
}

export interface TurnRailOptions {
  messagesEl: HTMLElement;
  hostEl?: HTMLElement;
  scrollFollow?: ScrollFollowController;
  dotPitch?: number;
  now?: () => number;
  onScrollToBottom?: (tabId: string) => void;
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

interface TabPagination {
  startIndex: number;
  endIndex: number;
}

export class TurnRail {
  readonly #messagesEl: HTMLElement;
  readonly #hostEl: HTMLElement;
  readonly #scrollFollow?: ScrollFollowController;
  readonly #dotPitch: number;
  readonly #onScrollToBottom?: (tabId: string) => void;
  readonly #renderIcon: (element: HTMLElement, icon: string) => void;

  readonly #turnsByTab = new Map<string, TurnRecord[]>();
  readonly #paginationByTab = new Map<string, TabPagination>();
  readonly #activeTurnByTab = new Map<string, boolean>();

  readonly #railEl: HTMLElement;
  readonly #prevBtn: HTMLButtonElement;
  readonly #trackEl: HTMLElement;
  readonly #tooltipEl: HTMLElement;
  readonly #backToBottomEl: HTMLButtonElement;

  #visibleTabId: string | undefined;
  #resizeObserver: ResizeObserver | null = null;
  #scrollScheduled = false;
  #turnCounter = 0;

  constructor(options: TurnRailOptions) {
    this.#messagesEl = options.messagesEl;
    this.#hostEl = options.hostEl ?? options.messagesEl.parentElement ?? options.messagesEl;
    this.#scrollFollow = options.scrollFollow;
    this.#dotPitch = options.dotPitch ?? DEFAULT_DOT_PITCH_PX;
    this.#onScrollToBottom = options.onScrollToBottom;
    this.#renderIcon = options.iconRenderer ?? ((el, icon) => {
      try {
        setIcon(el, icon);
      } catch {
        // Fallback for non-Obsidian environments
        el.setAttribute("data-icon", icon);
      }
    });

    // Ensure host element has positioning context for absolute overlays
    if (this.#hostEl.style.position === "" && !this.#hostEl.classList.contains("hermesian-messages-container")) {
      const computed = this.#hostEl.ownerDocument?.defaultView?.getComputedStyle(this.#hostEl);
      if (!computed || computed.position === "static") {
        this.#hostEl.style.position = "relative";
      }
    }

    // --- Rail Element ---
    this.#railEl = this.#hostEl.createDiv({
      cls: "hermesian-turn-rail is-hidden",
      attr: {
        "aria-label": "对话轮次导航",
        role: "navigation",
      },
    });

    this.#prevBtn = this.#railEl.createEl("button", {
      cls: "hermesian-turn-rail-prev is-hidden",
      attr: {
        "aria-label": "查看更早轮次",
        title: "更早轮次",
        type: "button",
      },
    }) as HTMLButtonElement;
    const prevIcon = this.#prevBtn.createSpan({ cls: "hermesian-turn-rail-prev-icon" });
    this.#renderIcon(prevIcon, "chevron-up");

    this.#trackEl = this.#railEl.createDiv({
      cls: "hermesian-turn-rail-track",
      attr: { role: "list" },
    });

    this.#tooltipEl = this.#railEl.createDiv({
      cls: "hermesian-turn-rail-tooltip is-hidden",
      attr: { role: "tooltip" },
    });

    // --- Back to Bottom Floating Button ---
    this.#backToBottomEl = this.#hostEl.createEl("button", {
      cls: "hermesian-back-to-bottom is-hidden",
      attr: {
        "aria-label": "回到底部",
        title: "回到底部",
        type: "button",
      },
    }) as HTMLButtonElement;
    const btbIcon = this.#backToBottomEl.createSpan({ cls: "hermesian-back-to-bottom-icon" });
    this.#renderIcon(btbIcon, "arrow-down");

    // Event listeners
    this.#prevBtn.addEventListener("click", () => {
      this.#pageOlder();
    });

    this.#backToBottomEl.addEventListener("click", () => {
      this.#onBackToBottomClick();
    });

    this.#messagesEl.addEventListener("scroll", () => {
      this.#scheduleScrollUpdate();
    }, { passive: true });

    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => {
        this.handleResize();
      });
      this.#resizeObserver.observe(this.#messagesEl);
    }
  }

  get railEl(): HTMLElement {
    return this.#railEl;
  }

  get prevBtn(): HTMLButtonElement {
    return this.#prevBtn;
  }

  get trackEl(): HTMLElement {
    return this.#trackEl;
  }

  get tooltipEl(): HTMLElement {
    return this.#tooltipEl;
  }

  get backToBottomEl(): HTMLButtonElement {
    return this.#backToBottomEl;
  }

  get visibleTabId(): string | undefined {
    return this.#visibleTabId;
  }

  getTurns(tabId: string): readonly TurnRecord[] {
    return this.#turnsByTab.get(tabId) ?? [];
  }

  getPagination(tabId: string): TabPagination | undefined {
    return this.#paginationByTab.get(tabId);
  }

  /**
   * Registers a user message as the start of a turn.
   */
  registerUserMessage(tabId: string, userMessageEl: HTMLElement, text: string): void {
    const turns = this.#turnsByTab.get(tabId) ?? [];
    const turnId = `turn-${++this.#turnCounter}`;
    const record: TurnRecord = {
      id: turnId,
      text,
      userMessageEl,
    };
    turns.push(record);
    this.#turnsByTab.set(tabId, turns);

    // Update pagination: by default new turn keeps the view on the latest page
    const pageSize = this.calculatePageSize();
    this.#paginationByTab.set(tabId, {
      endIndex: turns.length,
      startIndex: Math.max(0, turns.length - pageSize),
    });

    if (this.#visibleTabId === tabId) {
      this.render();
      this.updateScrollPosition();
    }
  }

  /**
   * Associates the turn response element (.hermesian-turn) with the latest turn of a tab.
   */
  registerTurn(tabId: string, turnEl: HTMLElement): void {
    const turns = this.#turnsByTab.get(tabId);
    if (!turns || turns.length === 0) {
      return;
    }
    const latest = turns[turns.length - 1];
    latest.turnEl = turnEl;
  }

  /**
   * Sets whether the latest turn of a tab is actively streaming.
   */
  setActiveTurn(tabId: string, active: boolean): void {
    this.#activeTurnByTab.set(tabId, active);
    if (this.#visibleTabId === tabId) {
      this.#updateActiveTurnDot();
    }
  }

  /**
   * Switches the active tab displayed by the rail.
   */
  switchTab(tabId: string): void {
    this.#visibleTabId = tabId;
    this.render();
    this.updateScrollPosition();
  }

  /**
   * Clears state for a tab when it is closed.
   */
  forget(tabId: string): void {
    this.#turnsByTab.delete(tabId);
    this.#paginationByTab.delete(tabId);
    this.#activeTurnByTab.delete(tabId);
    if (this.#visibleTabId === tabId) {
      this.#visibleTabId = undefined;
      this.render();
    }
  }

  /**
   * Clears turns for a tab without forgetting the tab itself.
   */
  clearTab(tabId: string): void {
    this.#turnsByTab.delete(tabId);
    this.#paginationByTab.delete(tabId);
    this.#activeTurnByTab.delete(tabId);
    if (this.#visibleTabId === tabId) {
      this.render();
      this.updateScrollPosition();
    }
  }

  /**
   * Dynamically calculates page capacity based on available height.
   */
  calculatePageSize(): number {
    const height = this.#messagesEl.clientHeight;
    if (height <= 0) {
      return 20;
    }
    // Reserve vertical space for up arrow and margins (~32px)
    const available = Math.max(0, height - 32);
    return Math.max(2, Math.floor(available / this.#dotPitch));
  }

  /**
   * Handles container resize: updates pagination window if page capacity changes.
   */
  handleResize(): void {
    if (!this.#visibleTabId) {
      return;
    }
    const turns = this.#turnsByTab.get(this.#visibleTabId) ?? [];
    if (turns.length === 0) {
      return;
    }
    const pageSize = this.calculatePageSize();
    const current = this.#paginationByTab.get(this.#visibleTabId);
    if (current) {
      current.startIndex = Math.max(0, current.endIndex - pageSize);
    } else {
      this.#paginationByTab.set(this.#visibleTabId, {
        endIndex: turns.length,
        startIndex: Math.max(0, turns.length - pageSize),
      });
    }
    this.render();
  }

  /**
   * Re-renders the turn rail for the current visible tab.
   */
  render(): void {
    const tabId = this.#visibleTabId;
    if (!tabId) {
      this.#railEl.classList.add("is-hidden");
      this.#backToBottomEl.classList.add("is-hidden");
      this.#trackEl.empty();
      return;
    }

    const turns = this.#turnsByTab.get(tabId) ?? [];
    if (turns.length < 2) {
      this.#railEl.classList.add("is-hidden");
      this.#trackEl.empty();
      return;
    }

    this.#railEl.classList.remove("is-hidden");

    let pagination = this.#paginationByTab.get(tabId);
    const pageSize = this.calculatePageSize();
    if (!pagination) {
      pagination = {
        endIndex: turns.length,
        startIndex: Math.max(0, turns.length - pageSize),
      };
      this.#paginationByTab.set(tabId, pagination);
    } else {
      // Clamp boundaries
      pagination.endIndex = Math.min(turns.length, Math.max(1, pagination.endIndex));
      pagination.startIndex = Math.max(0, pagination.endIndex - pageSize);
    }

    // Up arrow visibility: visible only if older turns exist before the current page
    this.#prevBtn.classList.toggle("is-hidden", pagination.startIndex === 0);

    // Render dots
    this.#trackEl.empty();
    const visibleTurnIndex = this.#getVisibleTurnIndex(tabId);
    const isTabActive = this.#activeTurnByTab.get(tabId) === true;
    const latestTurnIndex = turns.length - 1;

    for (let i = pagination.startIndex; i < pagination.endIndex; i++) {
      const turn = turns[i];
      const dot = this.#trackEl.createEl("button", {
        cls: "hermesian-turn-rail-dot",
        attr: {
          "data-turn-id": turn.id,
          "data-turn-index": String(i),
          role: "listitem",
          type: "button",
        },
      }) as HTMLButtonElement;

      const previewText = turn.text.length > MAX_PREVIEW_CHARS
        ? `${turn.text.slice(0, MAX_PREVIEW_CHARS)}…`
        : turn.text;

      // Single hover preview surface: no native `title` (it stacks a second
      // OS tooltip on top of the custom one). The turn number lives only in
      // the compact tooltip and the accessible name.
      dot.setAttribute("aria-label", `轮次 ${i + 1}: ${previewText}`);
      dot.setAttribute("data-preview", previewText);

      if (i === visibleTurnIndex) {
        dot.classList.add("is-current");
      }

      if (i === latestTurnIndex && isTabActive) {
        dot.classList.add("is-working");
      }

      // Hover preview
      dot.addEventListener("mouseenter", () => {
        this.#showTooltip(dot, `${i + 1} · ${previewText}`);
      });
      dot.addEventListener("mouseleave", () => {
        this.#hideTooltip();
      });

      // Click to navigate
      dot.addEventListener("click", () => {
        this.#jumpToTurn(tabId, turn, i);
      });
    }
  }

  /**
   * Updates which dot has the .is-current class and updates back-to-bottom visibility.
   */
  updateScrollPosition(): void {
    if (!this.#visibleTabId) {
      return;
    }
    const tabId = this.#visibleTabId;
    const turns = this.#turnsByTab.get(tabId) ?? [];
    if (turns.length >= 2) {
      const visibleIndex = this.#getVisibleTurnIndex(tabId);
      const dots = this.#trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");
      dots.forEach((dot) => {
        const index = Number(dot.getAttribute("data-turn-index"));
        dot.classList.toggle("is-current", index === visibleIndex);
      });
    }

    this.#updateBackToBottomVisibility(tabId);
  }

  destroy(): void {
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
    this.#railEl.remove();
    this.#backToBottomEl.remove();
  }

  #scheduleScrollUpdate(): void {
    if (this.#scrollScheduled) {
      return;
    }
    this.#scrollScheduled = true;
    window.requestAnimationFrame(() => {
      this.#scrollScheduled = false;
      this.updateScrollPosition();
    });
  }

  #getVisibleTurnIndex(tabId: string): number {
    const turns = this.#turnsByTab.get(tabId) ?? [];
    if (turns.length === 0) {
      return -1;
    }
    const scrollTop = this.#messagesEl.scrollTop;
    let bestIndex = 0;
    for (let i = 0; i < turns.length; i++) {
      const turnTop = turns[i].userMessageEl.offsetTop;
      if (turnTop <= scrollTop + 10) {
        bestIndex = i;
      } else {
        break;
      }
    }
    return bestIndex;
  }

  #updateActiveTurnDot(): void {
    if (!this.#visibleTabId) {
      return;
    }
    const tabId = this.#visibleTabId;
    const turns = this.#turnsByTab.get(tabId) ?? [];
    const isTabActive = this.#activeTurnByTab.get(tabId) === true;
    const latestIndex = turns.length - 1;

    const dots = this.#trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");
    dots.forEach((dot) => {
      const index = Number(dot.getAttribute("data-turn-index"));
      dot.classList.toggle("is-working", index === latestIndex && isTabActive);
    });
  }

  #pageOlder(): void {
    if (!this.#visibleTabId) {
      return;
    }
    const tabId = this.#visibleTabId;
    const pagination = this.#paginationByTab.get(tabId);
    if (!pagination || pagination.startIndex === 0) {
      return;
    }
    const pageSize = this.calculatePageSize();
    pagination.endIndex = pagination.startIndex;
    pagination.startIndex = Math.max(0, pagination.endIndex - pageSize);
    this.render();
  }

  #jumpToTurn(tabId: string, turn: TurnRecord, _index: number): void {
    // 1. Scroll user message to the top of messagesEl
    const targetScrollTop = turn.userMessageEl.offsetTop;
    this.#messagesEl.scrollTop = targetScrollTop;

    // 2. Treat as manual user scroll to pause follow if away from bottom
    const geometry = readScrollGeometry(this.#messagesEl);
    this.#scrollFollow?.syncFromGeometry(tabId, geometry, { userInitiated: true });
    if (distanceFromBottom(geometry) > (this.#scrollFollow?.thresholdPx ?? DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX)) {
      this.#scrollFollow?.lock(tabId);
    }

    // 3. Update highlight and back-to-bottom
    this.updateScrollPosition();
  }

  #showTooltip(dot: HTMLElement, text: string): void {
    this.#tooltipEl.textContent = text;
    this.#tooltipEl.classList.remove("is-hidden");
    const dotRect = dot.getBoundingClientRect();
    const railRect = this.#railEl.getBoundingClientRect();
    const top = dotRect.top - railRect.top + dotRect.height / 2 - this.#tooltipEl.offsetHeight / 2;
    const maxTop = Math.max(0, this.#railEl.clientHeight - this.#tooltipEl.offsetHeight);
    this.#tooltipEl.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
  }

  #hideTooltip(): void {
    this.#tooltipEl.classList.add("is-hidden");
  }

  #onBackToBottomClick(): void {
    if (!this.#visibleTabId) {
      return;
    }
    const tabId = this.#visibleTabId;
    // 1. Reset pagination to latest page
    const turns = this.#turnsByTab.get(tabId) ?? [];
    const pageSize = this.calculatePageSize();
    this.#paginationByTab.set(tabId, {
      endIndex: turns.length,
      startIndex: Math.max(0, turns.length - pageSize),
    });

    // 2. Unlock follow & trigger scroll to bottom
    this.#scrollFollow?.unlock(tabId);
    this.#onScrollToBottom?.(tabId);

    // 3. Update UI
    this.render();
    this.#updateBackToBottomVisibility(tabId);
  }

  #updateBackToBottomVisibility(tabId: string): void {
    if (!this.#scrollFollow) {
      this.#backToBottomEl.classList.add("is-hidden");
      return;
    }
    const isLocked = this.#scrollFollow.isLocked(tabId);
    const geometry = readScrollGeometry(this.#messagesEl);
    const dist = distanceFromBottom(geometry);
    const threshold = this.#scrollFollow.thresholdPx;
    const shouldShow = isLocked && dist > threshold;
    this.#backToBottomEl.classList.toggle("is-hidden", !shouldShow);
  }
}
