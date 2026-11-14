export interface SidebarShellElements {
  addConversationButtonEl: HTMLButtonElement;
  contextGaugeEl: HTMLElement;
  contextGaugeFillEl: SVGCircleElement;
  conversationTabsEl: HTMLElement;
  historyButtonEl: HTMLButtonElement;
  messagesEl: HTMLElement;
  root: HTMLElement;
  statusEl: HTMLElement;
  /** Header conversation title; clickable entry point for the title popover. */
  headerTitleEl: HTMLElement;
  topDockEl: HTMLElement;
}

export interface SidebarShellCallbacks {
  onAddConversation(): void;
  onMessagesClick(event: MouseEvent): void;
  onOpenHistory(): void;
}

export function createSidebarShell(
  containerEl: HTMLElement,
  callbacks: SidebarShellCallbacks,
): SidebarShellElements {
  const root = (containerEl.classList?.contains("view-content")
    ? containerEl
    : containerEl.children[1] ?? containerEl) as HTMLElement;
  root.empty();
  root.addClass("hermesian-view");

  // --- Top Dock (Shared Theme-Adaptive Glass container) ---
  const topDockEl = root.createDiv({ cls: "hermesian-top-dock" });

  // --- Header Row in Top Dock ---
  const header = topDockEl.createDiv({ cls: "hermesian-header" });
  const identity = header.createDiv({ cls: "hermesian-identity" });
  identity.createSpan({ cls: "hermesian-logo" });
  // The header title shows the active conversation title (not a static brand
  // label). Text/`title` are filled in by the view via `updateHeaderTitle()`.
  const headerTitleEl = identity.createSpan({
    attr: {
      "aria-haspopup": "dialog",
      role: "button",
      tabindex: "0",
      title: "未命名会话",
    },
    cls: "hermesian-title hermesian-title--conversation",
    text: "未命名会话",
  });
  const statusEl = identity.createSpan({
    attr: {
      "aria-atomic": "true",
      "aria-live": "polite",
      role: "status",
    },
    text: "Disconnected",
    cls: "hermesian-status",
  });

  // --- Tabs Row in Top Dock (tab list + right-aligned actions) ---
  // The actions live beside the tab list (not inside it): the tab renderer
  // empties its host element on every render, which would destroy them.
  const tabsRowEl = topDockEl.createDiv({ cls: "hermesian-tabs-row" });
  const conversationTabsEl = tabsRowEl.createDiv({
    attr: { "aria-label": "Hermes conversations", role: "tablist" },
    cls: "hermesian-conversation-tabs",
  });
  const tabsActionsEl = tabsRowEl.createDiv({ cls: "hermesian-tabs-actions" });

  const contextGaugeEl = tabsActionsEl.createDiv({
    attr: {
      "aria-haspopup": "dialog",
      "aria-label": "上下文: 0%",
      role: "button",
      tabindex: "0",
    },
    cls: "hermesian-context-gauge",
  });
  contextGaugeEl.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      contextGaugeEl.click();
    }
  });
  contextGaugeEl.innerHTML = `
    <svg viewBox="0 0 20 20" class="hermesian-context-gauge-svg">
      <circle class="hermesian-context-gauge-track" cx="10" cy="10" r="7"></circle>
      <circle class="hermesian-context-gauge-fill" cx="10" cy="10" r="7"></circle>
    </svg>
  `.trim();
  const contextGaugeFillEl = contextGaugeEl.querySelector(
    ".hermesian-context-gauge-fill",
  ) as SVGCircleElement;

  const historyButtonEl = tabsActionsEl.createEl("button", {
    attr: {
      "aria-label": "View Hermes history",
      title: "Browse and resume historical sessions",
      type: "button",
    },
    cls: "clickable-icon",
  }) as HTMLButtonElement;

  const addConversationButtonEl = tabsActionsEl.createEl("button", {
    attr: {
      "aria-label": "Add conversation",
      title: "Add conversation",
      type: "button",
    },
    cls: "clickable-icon",
  }) as HTMLButtonElement;

  // --- Messages ---
  const messagesEl = root.createDiv({ cls: "hermesian-messages" });

  // Wire callbacks
  addConversationButtonEl.addEventListener("click", () => {
    callbacks.onAddConversation();
  });
  historyButtonEl.addEventListener("click", () => {
    callbacks.onOpenHistory();
  });
  messagesEl.addEventListener("click", (event) => {
    callbacks.onMessagesClick(event);
  });

  return {
    addConversationButtonEl,
    contextGaugeEl,
    contextGaugeFillEl,
    conversationTabsEl,
    historyButtonEl,
    messagesEl,
    root,
    statusEl,
    headerTitleEl,
    topDockEl,
  };
}
