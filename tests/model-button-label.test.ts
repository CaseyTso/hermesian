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
  Modal: class {},
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
import type { HermesModelOption, HermesSessionState } from "../src/types";

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

const MODEL: HermesModelOption = {
  description: "",
  modelId: "gemini-3.8-flash-high",
  name: "Gemini 3.8 Flash (high)",
  providerId: "google",
  providerName: "Google",
  switchId: "google:gemini-3.8-flash-high",
};

function modelHarness() {
  const workspace: PersistedConversationWorkspace = {
    activeTabId: "tab-1",
    nextLabel: 2,
    tabs: [
      {
        draft: "",
        id: "tab-1",
        includeCurrentDocumentContext: true,
        label: 1,
        reasoningEffort: "high",
        sessionId: "sess-1",
      },
    ],
    version: 2,
  };

  const clients = new Map([
    [
      "tab-1",
      {
        sessionId: "sess-1",
        isBusy: false,
        appliedReasoningEffort: "high",
        connect: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {}),
        newSession: vi.fn(async () => {}),
        loadSessionHistory: vi.fn(async () => []),
      },
    ],
  ]);
  const controller = new ConversationController({
    clients: {
      acquireClient: (id) => clients.get(id)!,
      getClient: (id) => clients.get(id),
      isCurrentClient: (id, client) => clients.get(id) === client,
      releaseClient: async () => {},
    },
    workspace: {
      getWorkspace: () => workspace,
      setWorkspace: (next) => {
        void next;
      },
    },
  });
  const plugin = {
    peekClient: (id: string) => clients.get(id),
    getConversationWorkspace: vi.fn(() => workspace),
    getReasoningEffort: vi.fn(() => "high"),
    setReasoningEffort: vi.fn(),
    setConversationWorkspace: vi.fn(),
    canApplyConnectionSettings: vi.fn(() => true),
    settings: { hiddenModelSwitchIds: [] },
  };

  const app = { workspace: { layoutReady: true, onLayoutReady: vi.fn() } };
  const view: any = new HermesianSidebarView({ app } as any, plugin as any);
  view.conversationWorkspace = workspace;
  view.controller = controller;
  view.turnManager = { isBusy: () => false };

  const modelLabelEl = document.createElement("span");
  const modelButtonEl = document.createElement("button");
  modelButtonEl.appendChild(modelLabelEl);
  view.modelLabelEl = modelLabelEl;
  view.modelButtonEl = modelButtonEl;

  const reasoningLabelEl = document.createElement("span");
  const reasoningButtonEl = document.createElement("button");
  reasoningButtonEl.appendChild(reasoningLabelEl);
  view.reasoningLabelEl = reasoningLabelEl;
  view.reasoningButtonEl = reasoningButtonEl;

  view.addConversationButtonEl = document.createElement("button");
  view.historyButtonEl = document.createElement("button");
  view.contextGaugeEl = document.createElement("div");
  view.contextGaugeFillEl = document.createElement("span");

  return { view, modelLabelEl, modelButtonEl };
}

function stateWith(patch: Partial<HermesSessionState>): HermesSessionState {
  return {
    catalogLoading: false,
    commands: [],
    models: [MODEL],
    skillCatalogLoading: false,
    skills: [],
    switchingModel: false,
    ...patch,
  };
}

describe("Compact control capsule — model button label", () => {
  it("shows only the model's own id, with the provider moved into the tooltip", () => {
    const { view, modelLabelEl, modelButtonEl } = modelHarness();

    view.renderSessionState(stateWith({ currentModel: MODEL }));

    // Visible text: bare model id, no "Provider · Name" prefix.
    expect(modelLabelEl.textContent).toBe("gemini-3.8-flash-high");
    expect(modelLabelEl.textContent).not.toContain("Google");
    expect(modelLabelEl.textContent).not.toContain("Gemini 3.8 Flash (high)");
    // Tooltip carries the provider identity.
    expect(modelButtonEl.getAttribute("title")).toBe("Google · gemini-3.8-flash-high");
    // The accessible name keeps the provider too (screen readers get it).
    expect(modelButtonEl.getAttribute("aria-label")).toBe(
      "Google gemini-3.8-flash-high",
    );
  });

  it("keeps the non-current status labels unchanged in both label and tooltip", () => {
    const { view, modelLabelEl, modelButtonEl } = modelHarness();

    view.renderSessionState(stateWith({ currentModel: undefined, switchingModel: true }));
    expect(modelLabelEl.textContent).toBe("Switching model…");
    expect(modelButtonEl.getAttribute("title")).toBe("Switching model…");
    expect(modelButtonEl.getAttribute("aria-label")).toBe("Switching model…");

    view.renderSessionState(stateWith({ currentModel: undefined, catalogLoading: true }));
    expect(modelLabelEl.textContent).toBe("Loading models…");
    expect(modelButtonEl.getAttribute("title")).toBe("Loading models…");

    view.renderSessionState(stateWith({ currentModel: undefined, catalogLoading: false }));
    expect(modelLabelEl.textContent).toBe("Model unavailable");
    expect(modelButtonEl.getAttribute("title")).toBe("Model unavailable");
  });
});
