import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  ItemView: class {
    app: any;
    containerEl = document.createElement("div");
    constructor(leaf: any) {
      this.app = leaf.app;
    }
  },
  SuggestModal: class {},
  MarkdownView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn(async () => undefined) },
  Notice: vi.fn(),
  setIcon: vi.fn(),
}));

import { HermesianSidebarView } from "../src/view";
import { ConversationController } from "../src/conversation-controller";
import type { PersistedConversationWorkspace } from "../src/conversation-tabs";
import type { ReasoningEffort } from "../src/types";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  (window.HTMLElement.prototype as any).setText = function (text: string) {
    this.textContent = text;
  };
});

function uiHarness(initialWorkspace?: PersistedConversationWorkspace) {
  let workspace: PersistedConversationWorkspace = initialWorkspace ?? {
    activeTabId: "tab-1",
    nextLabel: 3,
    tabs: [
      {
        draft: "",
        id: "tab-1",
        includeCurrentDocumentContext: true,
        label: 1,
        reasoningEffort: "high",
        sessionId: "sess-1",
      },
      {
        draft: "",
        id: "tab-2",
        includeCurrentDocumentContext: true,
        label: 2,
        reasoningEffort: "low",
        sessionId: "sess-2",
      },
    ],
    version: 2,
  };

  const clients = new Map(workspace.tabs.map((tab) => [tab.id, {
    sessionId: tab.sessionId ?? undefined, isBusy: false, appliedReasoningEffort: tab.reasoningEffort,
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}), loadSessionHistory: vi.fn(async () => []),
  }]));
  let persist: (() => Promise<void>) | undefined;
  const controller = new ConversationController({
    clients: {
      acquireClient: (id) => clients.get(id)!, getClient: (id) => clients.get(id),
      isCurrentClient: (id, client) => clients.get(id) === client, releaseClient: async () => {},
    },
    workspace: { getWorkspace: () => workspace, setWorkspace: (next, options) => {
      workspace = next;
      return options?.flush ? persist?.() : undefined;
    } },
  });
  const plugin = {
    peekClient: (id: string) => clients.get(id),
    getConversationWorkspace: vi.fn(() => workspace),
    getReasoningEffort: vi.fn((tabId?: string) => {
      const id = tabId ?? workspace.activeTabId;
      const tab = workspace.tabs.find((t) => t.id === id);
      return tab?.reasoningEffort ?? "default";
    }),
    setReasoningEffort: vi.fn((tabId: string, effort: ReasoningEffort) => controller.setReasoningEffort(tabId, effort)),
    setConversationWorkspace: vi.fn((ws: PersistedConversationWorkspace) => {
      workspace = ws;
    }),
    canApplyConnectionSettings: vi.fn(() => true),
  };

  const app = { workspace: { layoutReady: true, onLayoutReady: vi.fn() } };
  const view: any = new HermesianSidebarView({ app } as any, plugin as any);
  view.conversationWorkspace = workspace;
  view.controller = controller;
  view.turnManager = { isBusy: () => false };
  controller.subscribe((snapshot) => view.handleControllerSnapshot(snapshot));

  const reasoningLabelEl = document.createElement("span");
  const reasoningButtonEl = document.createElement("button");
  reasoningButtonEl.appendChild(reasoningLabelEl);
  view.reasoningLabelEl = reasoningLabelEl;
  view.reasoningButtonEl = reasoningButtonEl;

  return { view, plugin, controller, clients, getWorkspace: () => workspace,
    setPersist: (hook: (() => Promise<void>) | undefined) => { persist = hook; } };
}

describe("Reasoning effort UI integration", () => {
  it("renders the reasoning button label from the active tab's reasoning effort", () => {
    const { view } = uiHarness();

    view.renderReasoningButton();

    expect(view.reasoningLabelEl.textContent).toBe("Thinking: high");
    expect(view.reasoningButtonEl.getAttribute("title")).toBe("Thinking: high");
  });

  it("updates reasoning button label when switching between tabs with different efforts", () => {
    const { view, getWorkspace } = uiHarness();

    // Initially tab-1 (effort: 'high')
    view.renderReasoningButton();
    expect(view.reasoningLabelEl.textContent).toBe("Thinking: high");

    // Switch active tab to tab-2 (effort: 'low')
    view.conversationWorkspace = {
      ...getWorkspace(),
      activeTabId: "tab-2",
    };

    view.renderReasoningButton();
    expect(view.reasoningLabelEl.textContent).toBe("Thinking: low");
  });

  it("chooses a new reasoning effort for a tab and persists it without disconnecting clients", async () => {
    const { view, plugin, getWorkspace } = uiHarness();

    await view.chooseReasoningEffort("tab-1", "ultra");

    expect(plugin.setReasoningEffort).toHaveBeenCalledWith("tab-1", "ultra");
    expect(getWorkspace().tabs.find((t) => t.id === "tab-1")?.reasoningEffort).toBe("ultra");
    expect(view.reasoningLabelEl.textContent).toBe("Thinking: ultra");

    // Tab 2 remains unchanged
    expect(getWorkspace().tabs.find((t) => t.id === "tab-2")?.reasoningEffort).toBe("low");
  });

  it("keeps controller readiness snapshots synchronized and labels next-turn changes", async () => {
    const { view, controller, clients } = uiHarness();
    await controller.initialize();
    controller.setPromptRunning("tab-1", true);
    clients.get("tab-1")!.isBusy = true;
    await view.chooseReasoningEffort("tab-1", "low");
    expect((await controller.ensureClientForTab("tab-1")).workspace.tabs[0].reasoningEffort).toBe("low");
    expect(view.reasoningLabelEl.textContent).toBe("Thinking: low (next turn)");
    expect(view.reasoningButtonEl.getAttribute("title")).toBe("Active: high · Next turn: low");
    expect(clients.get("tab-1")!.disconnect).not.toHaveBeenCalled();
    controller.setPromptRunning("tab-1", false);
    clients.get("tab-1")!.isBusy = false;
    view.renderReasoningButton();
    expect(view.reasoningLabelEl.textContent).toBe("Thinking: low");
  });

  it("serializes preference saves and rolls back only owned fields, preserving concurrent typing", async () => {
    const h = uiHarness();
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((_, reject) => { fail = reject; });
    h.setPersist(() => gate);
    const first = h.controller.setReasoningEffort("tab-1", "low");
    const failure = expect(first).rejects.toThrow("disk unavailable");
    await Promise.resolve();
    const typed = { ...h.getWorkspace(), tabs: h.getWorkspace().tabs.map((tab) => ({ ...tab, draft: "new typing" })) };
    h.plugin.setConversationWorkspace(typed);
    const second = h.controller.setReasoningEffort("tab-2", "ultra");
    h.setPersist(undefined);
    fail(new Error("disk unavailable"));
    await failure;
    await second;
    expect(h.getWorkspace().tabs.map((t) => t.reasoningEffort)).toEqual(["high", "ultra"]);
    expect(h.getWorkspace().tabs.map((t) => t.draft)).toEqual(["new typing", "new typing"]);
    expect(h.controller.getSnapshot().workspace).toEqual(h.getWorkspace());
    expect(h.view.conversationWorkspace).toEqual(h.getWorkspace());
  });

  it("does nothing when choosing the same reasoning effort", async () => {
    const { view, plugin } = uiHarness();

    await view.chooseReasoningEffort("tab-1", "high");

    expect(plugin.setReasoningEffort).not.toHaveBeenCalled();
  });
});
