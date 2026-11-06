import type { PersistedConversationTab } from "../conversation-tabs";

export interface ConversationTabsState {
  activeTabId: string | undefined;
  isTabBusy(tabId: string): boolean;
  isTabLoading(tabId: string): boolean;
  isTabFailed?(tabId: string): boolean;
  tabNavigationDisabled: boolean;
  tabs: PersistedConversationTab[];
  resolveTabTitle?(tab: PersistedConversationTab): string;
}

export interface ConversationTabsCallbacks {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onContextMenu?(tabId: string, anchorEl: HTMLElement, event: MouseEvent): void;
}

export function renderConversationTabsView(
  hostEl: HTMLElement,
  state: ConversationTabsState,
  callbacks: ConversationTabsCallbacks,
): void {
  hostEl.empty();
  hostEl.setAttr("aria-label", "Hermes conversations");
  hostEl.setAttr("role", "tablist");

  for (const tab of state.tabs) {
    const active = tab.id === state.activeTabId;
    const deferred = tab.sessionId === null;
    const working = state.isTabBusy(tab.id);
    const failed = state.isTabFailed?.(tab.id) === true;
    const loading = !failed && (deferred || state.isTabLoading(tab.id));
    const activityLabel = failed ? ", connection failed, select to retry" : working ? ", responding" : loading ? ", starting" : "";
    const activityTitle = failed ? " · Connection failed · Select to retry" : working ? " · Responding" : loading ? " · Starting" : "";
    const resolvedTitle = state.resolveTabTitle?.(tab)?.trim() || tab.title?.trim() || "";
    const titleAttr = resolvedTitle
      ? `${resolvedTitle} · Conversation ${tab.label}${activityTitle}`
      : `Conversation ${tab.label}${activityTitle}`;
    const ariaLabel = resolvedTitle
      ? `Conversation ${tab.label}: ${resolvedTitle}${activityLabel}`
      : `Conversation ${tab.label}${activityLabel}`;
    const button = hostEl.createEl("button", {
      attr: {
        "aria-busy": String(working || loading),
        "aria-label": ariaLabel,
        "aria-selected": String(active),
        "data-conversation-tab-id": tab.id,
        role: "tab",
        title: titleAttr,
        type: "button",
      },
      cls: `hermesian-conversation-tab${active ? " is-active" : ""}${working ? " is-working" : ""}${loading ? " is-loading" : ""}${deferred ? " is-deferred" : ""}`,
    });
    button.createSpan({
      cls: "hermesian-tab-label",
      text: String(tab.label),
    });
    const closeBtn = button.createSpan({
      attr: {
        "aria-label": `Close conversation ${tab.label}`,
        role: "button",
        tabindex: "-1",
        title: `Close conversation ${tab.label}`,
      },
      cls: "hermesian-tab-close",
      text: "×",
    });
    button.disabled = state.tabNavigationDisabled;
    button.addEventListener("click", () => {
      callbacks.onActivate(tab.id);
    });
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      callbacks.onClose(tab.id);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      callbacks.onContextMenu?.(tab.id, button, event);
    });
  }

  hostEl
    .querySelector<HTMLElement>(".hermesian-conversation-tab.is-active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
