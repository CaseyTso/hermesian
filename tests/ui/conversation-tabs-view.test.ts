// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  renderConversationTabsView,
  type ConversationTabsCallbacks,
  type ConversationTabsState,
} from "../../src/ui/conversation-tabs-view";
import type { PersistedConversationTab } from "../../src/conversation-tabs";

// Minimal mock of Obsidian's HTMLElement extensions that view.ts uses.
// The extracted function only calls setAttr, createEl, empty, addEventListener,
// querySelector, and scrollIntoView — all standard DOM APIs.
(HTMLElement.prototype as any).setAttr = function (name: string, value: string) {
  this.setAttribute(name, value);
};
(HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
  const el = document.createElement(tag) as any;
  if (options.cls) el.className = options.cls;
  if (options.text !== undefined) el.textContent = String(options.text);
  if (options.attr) {
    for (const [key, val] of Object.entries(options.attr)) {
      el.setAttribute(key, String(val));
    }
  }
  this.appendChild(el);
  return el;
};
(HTMLElement.prototype as any).empty = function () {
  this.innerHTML = "";
};

function makeTab(overrides: Partial<PersistedConversationTab> = {}): PersistedConversationTab {
  return {
    draft: "",
    id: "tab-1",
    includeCurrentDocumentContext: true,
    label: 1,
    sessionId: "session-1",
    ...overrides,
  };
}

function defaults(callbacks: Partial<ConversationTabsCallbacks> = {}): ConversationTabsCallbacks {
  return {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    ...callbacks,
  };
}

describe("renderConversationTabsView", () => {
  it("renders tabs with role=tablist and role=tab", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [makeTab({ id: "tab-1", label: 1 })],
    };

    renderConversationTabsView(host, state, defaults());

    expect(host.getAttribute("role")).toBe("tablist");
    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("role")).toBe("tab");
    expect(button!.getAttribute("aria-selected")).toBe("true");
  });

  it("assigns consecutive labels 1…N", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-2",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [
        makeTab({ id: "tab-a", label: 1 }),
        makeTab({ id: "tab-b", label: 2 }),
        makeTab({ id: "tab-c", label: 3 }),
      ],
    };

    renderConversationTabsView(host, state, defaults());

    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].textContent).toBe("1");
    expect(buttons[1].textContent).toBe("2");
    expect(buttons[2].textContent).toBe("3");
  });

  it("marks the active tab with aria-selected true and is-active class", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-b",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [makeTab({ id: "tab-a" }), makeTab({ id: "tab-b" })],
    };

    renderConversationTabsView(host, state, defaults());

    const buttons = host.querySelectorAll("button");
    expect(buttons[0].getAttribute("aria-selected")).toBe("false");
    expect(buttons[0].classList.contains("is-active")).toBe(false);
    expect(buttons[1].getAttribute("aria-selected")).toBe("true");
    expect(buttons[1].classList.contains("is-active")).toBe(true);
  });

  it("adds is-working and aria-busy when a tab is busy", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: (id) => id === "tab-2",
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [makeTab({ id: "tab-1" }), makeTab({ id: "tab-2" })],
    };

    renderConversationTabsView(host, state, defaults());

    const buttons = host.querySelectorAll("button");
    expect(buttons[0].classList.contains("is-working")).toBe(false);
    expect(buttons[1].classList.contains("is-working")).toBe(true);
    expect(buttons[1].getAttribute("aria-busy")).toBe("true");
  });

  it("adds is-loading and aria-busy for deferred tabs", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [makeTab({ id: "tab-1", sessionId: null })],
    };

    renderConversationTabsView(host, state, defaults());

    const button = host.querySelector("button")!;
    expect(button.classList.contains("is-loading")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("prevents default on contextmenu and calls onClose", () => {
    const host = document.createElement("div");
    const onClose = vi.fn();
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [makeTab({ id: "tab-1" })],
    };

    renderConversationTabsView(host, state, defaults({ onClose }));

    const button = host.querySelector("button")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledWith("tab-1");
  });

  it("calls onActivate on click", () => {
    const host = document.createElement("div");
    const onActivate = vi.fn();
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [makeTab({ id: "tab-1" })],
    };

    renderConversationTabsView(host, state, defaults({ onActivate }));

    const button = host.querySelector("button")!;
    button.click();
    expect(onActivate).toHaveBeenCalledWith("tab-1");
  });

  it("still fires onActivate for loading tabs when navigation is enabled", () => {
    const host = document.createElement("div");
    const onActivate = vi.fn();
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: () => false,
      isTabLoading: (id) => id === "tab-2",
      tabNavigationDisabled: false,
      tabs: [
        makeTab({ id: "tab-1" }),
        makeTab({ id: "tab-2", sessionId: null, label: 2 }),
      ],
    };

    renderConversationTabsView(host, state, defaults({ onActivate }));

    const buttons = host.querySelectorAll("button");
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
    expect(buttons[1].classList.contains("is-loading")).toBe(true);
    buttons[1].click();
    expect(onActivate).toHaveBeenCalledWith("tab-2");
  });

  it("disables all tab buttons when tabNavigationDisabled is true", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: () => false,
      isTabLoading: () => false,
      tabNavigationDisabled: true,
      tabs: [
        makeTab({ id: "tab-1" }),
        makeTab({ id: "tab-2" }),
      ],
    };

    renderConversationTabsView(host, state, defaults());

    const buttons = host.querySelectorAll("button");
    for (const btn of buttons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("does not disable idle tabs when only one tab is busy", () => {
    const host = document.createElement("div");
    const state: ConversationTabsState = {
      activeTabId: "tab-1",
      isTabBusy: (id) => id === "tab-2",
      isTabLoading: () => false,
      tabNavigationDisabled: false,
      tabs: [
        makeTab({ id: "tab-1" }),
        makeTab({ id: "tab-2" }),
      ],
    };

    renderConversationTabsView(host, state, defaults());

    const buttons = host.querySelectorAll("button");
    // tab-1 is idle, should not be disabled
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    // tab-2 is busy but tabNavigationDisabled=false, so not disabled either
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
    // Both should have correct busy/working indicators though
    expect(buttons[0].classList.contains("is-working")).toBe(false);
    expect(buttons[1].classList.contains("is-working")).toBe(true);
  });
});
