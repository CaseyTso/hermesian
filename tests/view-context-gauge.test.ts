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
  setIcon: vi.fn((element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  }),
}));

import { HermesianSidebarView } from "../src/view";
import { ConversationController } from "../src/conversation-controller";
import {
  createConversationWorkspace,
  addPendingConversationTab,
} from "../src/conversation-tabs";

beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  (HTMLElement.prototype as any).show = function () {
    this.style.display = "";
  };
  (HTMLElement.prototype as any).hide = function () {
    this.style.display = "none";
  };
  (HTMLElement.prototype as any).setText = function (text: string) {
    this.textContent = text;
  };
  (HTMLElement.prototype as any).createDiv = function (options: any = {}) {
    const el = document.createElement("div");
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = String(options.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createSpan = function (options: any = {}) {
    const el = document.createElement("span");
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = String(options.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = String(options.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function viewHarness(options: { isDeferred?: boolean } = {}) {
  let workspace = createConversationWorkspace("tab-init", "session-init");
  if (options.isDeferred) {
    workspace = addPendingConversationTab(workspace, "tab-deferred");
    workspace.activeTabId = "tab-deferred";
  } else {
    workspace.activeTabId = "tab-init";
  }

  const client: any = {
    sessionId: options.isDeferred ? null : "session-init",
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
    loadSessionHistory: vi.fn(async () => []),
    steerActiveTurn: vi.fn(async () => ({ ok: false, reason: "queued" })),
    sendPrompt: vi.fn(async () => undefined),
  };

  const controller = new ConversationController({
    clients: {
      acquireClient: () => client,
      getClient: () => client,
      isCurrentClient: () => true,
      releaseClient: async () => undefined,
    },
    workspace: {
      getWorkspace: () => workspace,
      setWorkspace: (value) => {
        workspace = value;
      },
    },
    readLocalHistory: async () => [],
  });

  const plugin = {
    attachView: vi.fn(),
    getConversationControllerDependencies: vi.fn(),
    setConversationWorkspace: vi.fn((value) => {
      workspace = value;
    }),
    getCurrentDocumentContext: vi.fn(),
    getCurrentMarkdownFilePath: vi.fn(),
    peekClient: vi.fn(() => undefined),
    getClient: vi.fn(() => client),
    settings: { hiddenModelSwitchIds: [] },
  };

  const app = { workspace: { layoutReady: true, onLayoutReady: vi.fn() } };
  const view: any = new HermesianSidebarView({ app } as any, plugin as any);
  view.controller = controller;
  view.conversationWorkspace = workspace;
  view.composerDraft = { text: "", token: null, references: [] };
  view.includeCurrentDocumentContext = false;
  view.turnManager = {
    isBusy: () => false,
    clearQueuedSteers: () => undefined,
    appendSteer: () => undefined,
  };

  view.contextGaugeEl = document.createElement("div");
  view.contextGaugeFillEl = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  view.sidebarRootEl = document.createElement("div");

  vi.spyOn(view.contextGaugeEl, "getBoundingClientRect").mockReturnValue({
    bottom: 40,
    height: 30,
    left: 200,
    right: 230,
    top: 10,
    width: 30,
    x: 200,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect);

  vi.spyOn(view.sidebarRootEl, "getBoundingClientRect").mockReturnValue({
    bottom: 700,
    height: 690,
    left: 0,
    right: 320,
    top: 10,
    width: 320,
    x: 0,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect);

  for (const name of [
    "hideSlashMenu",
    "renderAddConversationControl",
    "renderConversationTabs",
    "renderSessionState",
    "renderReadinessStatus",
    "renderCurrentFile",
    "renderSelectionBar",
    "renderImageAttachmentBar",
  ]) {
    view[name] = vi.fn();
  }

  for (const name of [
    "composerEl",
    "composerStatusEl",
    "composerHintEl",
    "filePickerMenuEl",
    "statusEl",
    "steerModeEl",
    "modelLabelEl",
  ]) {
    view[name] = document.createElement("div");
  }

  for (const name of [
    "sendButtonEl",
    "stopButtonEl",
    "steerButtonEl",
    "dictationButtonEl",
    "filePickerButtonEl",
    "historyButtonEl",
    "reasoningButtonEl",
    "modelButtonEl",
  ]) {
    view[name] = document.createElement("button");
  }

  view.controllerUnsubscribe = controller.subscribe((snapshot) =>
    view.handleControllerSnapshot(snapshot),
  );

  return { view, controller, plugin, client, workspace };
}

describe("HermesianSidebarView Context Gauge Popover integration", () => {
  it("opens context gauge popover and clicking compress dispatches /compress via sendMessage", async () => {
    const h = viewHarness({ isDeferred: false });
    const dispatch = vi.spyOn(h.view, "sendMessage").mockResolvedValue(undefined);

    h.view.toggleContextGaugePopover();

    const popoverEl = document.body.querySelector(
      ".hermesian-context-popover",
    ) as HTMLElement;
    expect(popoverEl).not.toBeNull();

    const compressBtn = popoverEl.querySelector(
      ".hermesian-context-popover-compress-btn",
    ) as HTMLButtonElement;
    expect(compressBtn).not.toBeNull();
    expect(compressBtn.disabled).toBe(false);

    compressBtn.click();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      pending: expect.objectContaining({
        tabId: "tab-init",
        draft: expect.objectContaining({ text: "/compress" }),
      }),
    });
    expect(document.body.querySelector(".hermesian-context-popover")).toBeNull();
    expect(h.view.contextGaugePopover).toBeNull();
  });

  it("disables compress button when active tab has no sessionId (deferred tab) and click does not dispatch", async () => {
    const h = viewHarness({ isDeferred: true });
    const dispatch = vi.spyOn(h.view, "sendMessage").mockResolvedValue(undefined);

    h.view.toggleContextGaugePopover();

    const popoverEl = document.body.querySelector(
      ".hermesian-context-popover",
    ) as HTMLElement;
    expect(popoverEl).not.toBeNull();

    const compressBtn = popoverEl.querySelector(
      ".hermesian-context-popover-compress-btn",
    ) as HTMLButtonElement;
    expect(compressBtn).not.toBeNull();
    expect(compressBtn.disabled).toBe(true);
    expect(compressBtn.title).toBe("会话尚未建立连接");

    compressBtn.click();

    expect(dispatch).not.toHaveBeenCalled();
    expect(document.body.querySelector(".hermesian-context-popover")).not.toBeNull();
  });

  it("enforces mutual exclusivity between context gauge popover and title popover", async () => {
    const h = viewHarness({ isDeferred: false });
    const anchorBtn = document.createElement("button");
    document.body.appendChild(anchorBtn);

    // 1. Open context gauge popover
    h.view.toggleContextGaugePopover();
    expect(document.body.querySelector(".hermesian-context-popover")).not.toBeNull();

    // 2. Open title popover -> context gauge popover must detach
    h.view.openTitlePopover("tab-init", anchorBtn);
    expect(document.body.querySelector(".hermesian-context-popover")).toBeNull();
    expect(h.view.contextGaugePopover).toBeNull();
    expect(h.view.titlePopover?.isOpen()).toBe(true);

    // 3. Open context gauge popover again -> title popover must detach
    h.view.toggleContextGaugePopover();
    expect(h.view.titlePopover).toBeNull();
    expect(document.body.querySelector(".hermesian-context-popover")).not.toBeNull();
  });
});
