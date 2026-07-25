export interface SidebarShellElements {
  addConversationButtonEl: HTMLButtonElement;
  conversationTabsEl: HTMLElement;
  historyButtonEl: HTMLButtonElement;
  messagesEl: HTMLElement;
  root: HTMLElement;
  statusEl: HTMLElement;
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
  const root = containerEl.children[1] as HTMLElement;
  root.empty();
  root.addClass("hermesian-view");

  // --- Header ---
  const header = root.createDiv({ cls: "hermesian-header" });
  const identity = header.createDiv({ cls: "hermesian-identity" });
  identity.createSpan({ cls: "hermesian-logo" });
  identity.createSpan({ text: "Hermesian", cls: "hermesian-title" });
  const statusEl = identity.createSpan({
    attr: {
      "aria-atomic": "true",
      "aria-live": "polite",
      role: "status",
    },
    text: "Disconnected",
    cls: "hermesian-status",
  });

  const headerActions = header.createDiv({ cls: "hermesian-header-actions" });

  const addConversationButtonEl = headerActions.createEl("button", {
    attr: {
      "aria-label": "Add conversation",
      title: "Add conversation",
      type: "button",
    },
    cls: "clickable-icon",
  }) as HTMLButtonElement;

  const historyButtonEl = headerActions.createEl("button", {
    attr: {
      "aria-label": "View Hermes history",
      title: "Browse and resume historical sessions",
      type: "button",
    },
    cls: "clickable-icon",
  }) as HTMLButtonElement;

  // --- Tabs ---
  const conversationTabsEl = root.createDiv({
    attr: { "aria-label": "Hermes conversations", role: "tablist" },
    cls: "hermesian-conversation-tabs",
  });

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
    conversationTabsEl,
    historyButtonEl,
    messagesEl,
    root,
    statusEl,
  };
}
