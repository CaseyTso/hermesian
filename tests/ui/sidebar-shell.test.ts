/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from "vitest";

import {
  createSidebarShell,
  type SidebarShellCallbacks,
} from "../../src/ui/sidebar-shell";

// Minimal mock of Obsidian's HTMLElement extensions
(HTMLElement.prototype as any).setAttr = function (name: string, value: string) {
  this.setAttribute(name, value);
};
(HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
  const el: any = document.createElement(tag);
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
  while (this.firstChild) this.removeChild(this.firstChild);
};
(HTMLElement.prototype as any).createDiv = function (options: any = {}) {
  return (this as any).createEl("div", options);
};
(HTMLElement.prototype as any).createSpan = function (options: any = {}) {
  return (this as any).createEl("span", options);
};
(HTMLElement.prototype as any).addClass = function (cls: string) {
  this.classList.add(cls);
};

function mockContainer(): HTMLElement {
  const container = document.createElement("div");
  // Simulate Obsidian's ItemView containerEl structure:
  // containerEl.children[1] is the content area
  container.appendChild(document.createElement("div")); // children[0]
  container.appendChild(document.createElement("div")); // children[1] = root
  return container;
}

function setup(callbacks?: Partial<SidebarShellCallbacks>) {
  const containerEl = mockContainer();
  const cb: SidebarShellCallbacks = {
    onAddConversation: vi.fn(),
    onMessagesClick: vi.fn(),
    onOpenHistory: vi.fn(),
    ...callbacks,
  };
  const shell = createSidebarShell(containerEl, cb);
  return { containerEl, shell, cb };
}

describe("createSidebarShell", () => {
  describe("DOM structure", () => {
    it("applies the hermesian-view class to the root element", () => {
      const { shell } = setup();
      expect(shell.root.classList.contains("hermesian-view")).toBe(true);
    });

    it("renders the Hermesian title", () => {
      const { shell } = setup();
      const title = shell.root.querySelector(".hermesian-title");
      expect(title).not.toBeNull();
      expect(title!.textContent).toBe("Hermesian");
    });

    it("renders the status element with correct ARIA attributes", () => {
      const { shell } = setup();
      const status = shell.root.querySelector(".hermesian-status");
      expect(status).not.toBeNull();
      expect(status!.getAttribute("role")).toBe("status");
      expect(status!.getAttribute("aria-live")).toBe("polite");
      expect(status!.textContent).toBe("Disconnected");
    });

    it("renders the Add Conversation button", () => {
      const { shell } = setup();
      expect(shell.addConversationButtonEl.getAttribute("aria-label")).toBe(
        "Add conversation",
      );
    });

    it("renders the History button", () => {
      const { shell } = setup();
      expect(shell.historyButtonEl.getAttribute("aria-label")).toBe(
        "View Hermes history",
      );
    });

    it("renders the conversation tabs container with tablist role", () => {
      const { shell } = setup();
      expect(shell.conversationTabsEl.getAttribute("role")).toBe("tablist");
      expect(shell.conversationTabsEl.classList.contains("hermesian-conversation-tabs")).toBe(true);
    });

    it("renders the messages container", () => {
      const { shell } = setup();
      expect(shell.messagesEl.classList.contains("hermesian-messages")).toBe(true);
    });

    it("renders the top dock container wrapping header and tabs", () => {
      const { shell } = setup();
      expect(shell.topDockEl).toBeInstanceOf(HTMLElement);
      expect(shell.topDockEl.classList.contains("hermesian-top-dock")).toBe(true);
      expect(shell.topDockEl.contains(shell.statusEl)).toBe(true);
      expect(shell.topDockEl.contains(shell.addConversationButtonEl)).toBe(true);
      expect(shell.topDockEl.contains(shell.conversationTabsEl)).toBe(true);
    });

    it("returns the root element for composer attachment", () => {
      const { shell } = setup();
      expect(shell.root).toBeInstanceOf(HTMLElement);
    });
  });

  describe("callbacks", () => {
    it("fires onAddConversation when Add button is clicked", () => {
      const { shell, cb } = setup();
      shell.addConversationButtonEl.click();
      expect(cb.onAddConversation).toHaveBeenCalledOnce();
    });

    it("fires onOpenHistory when History button is clicked", () => {
      const { shell, cb } = setup();
      shell.historyButtonEl.click();
      expect(cb.onOpenHistory).toHaveBeenCalledOnce();
    });

    it("fires onMessagesClick when messages area is clicked", () => {
      const { shell, cb } = setup();
      const event = new MouseEvent("click", { bubbles: true });
      shell.messagesEl.dispatchEvent(event);
      expect(cb.onMessagesClick).toHaveBeenCalledOnce();
    });
  });

  describe("dispose safety", () => {
    it("repeated create does not leave listeners from a previous shell", () => {
      const containerEl = mockContainer();

      // First shell
      const cb1: SidebarShellCallbacks = {
        onAddConversation: vi.fn(),
        onMessagesClick: vi.fn(),
        onOpenHistory: vi.fn(),
      };
      const shell1 = createSidebarShell(containerEl, cb1);
      shell1.addConversationButtonEl.click();
      expect(cb1.onAddConversation).toHaveBeenCalledTimes(1);

      // Second shell replaces first
      const cb2: SidebarShellCallbacks = {
        onAddConversation: vi.fn(),
        onMessagesClick: vi.fn(),
        onOpenHistory: vi.fn(),
      };
      const shell2 = createSidebarShell(containerEl, cb2);
      shell2.addConversationButtonEl.click();
      // Second callback should fire once, first callback should NOT fire again
      expect(cb2.onAddConversation).toHaveBeenCalledTimes(1);
      expect(cb1.onAddConversation).toHaveBeenCalledTimes(1);
    });
  });
});
