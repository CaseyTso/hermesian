import type { PersistedConversationTab } from "../conversation-tabs";

export interface ConversationTabsState {
  activeTabId: string | undefined;
  isTabBusy(tabId: string): boolean;
  isTabLoading(tabId: string): boolean;
  tabNavigationDisabled: boolean;
  tabs: PersistedConversationTab[];
}

export interface ConversationTabsCallbacks {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
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
    const loading = deferred || state.isTabLoading(tab.id);
    const activityLabel = working ? ", responding" : loading ? ", starting" : "";
    const activityTitle = working ? " · Responding" : loading ? " · Starting" : "";
    const button = hostEl.createEl("button", {
      attr: {
        "aria-busy": String(working || loading),
        "aria-label": `Conversation ${tab.label}${activityLabel}`,
        "aria-selected": String(active),
        "data-conversation-tab-id": tab.id,
        role: "tab",
        title: `Conversation ${tab.label}${activityTitle} · Right-click to close`,
        type: "button",
      },
      cls: `hermesian-conversation-tab${active ? " is-active" : ""}${working ? " is-working" : ""}${loading ? " is-loading" : ""}${deferred ? " is-deferred" : ""}`,
      text: String(tab.label),
    });
    button.disabled = state.tabNavigationDisabled;
    button.addEventListener("click", () => {
      callbacks.onActivate(tab.id);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      callbacks.onClose(tab.id);
    });
  }

  hostEl
    .querySelector<HTMLElement>(".hermesian-conversation-tab.is-active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
