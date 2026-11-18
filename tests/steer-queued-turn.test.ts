import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  ItemView: class {
    app: any;
    containerEl = document.createElement("div");
    constructor(leaf: any) {
      this.app = leaf.app;
    }
    registerDomEvent(_e: unknown, _t: string, _c: unknown) {}
  },
  Modal: class {},
  SuggestModal: class {},
  MarkdownView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: {
    render: vi.fn(async (_app: any, text: string, target: any) => {
      target.textContent = `MD(${text})`;
    }),
  },
  Notice: vi.fn(),
  setIcon: vi.fn(),
}));

import { HermesianSidebarView } from "../src/view";
import { ConversationController } from "../src/conversation-controller";
import { createConversationWorkspace } from "../src/conversation-tabs";
import { MessageRenderer, TurnManager } from "../src/ui/message-renderer";

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("Text", (window as any).Text);
  (HTMLElement.prototype as any).show = function () {
    this.style.display = "";
  };
  (HTMLElement.prototype as any).hide = function () {
    this.style.display = "none";
  };
  (HTMLElement.prototype as any).setText = function (t: string) {
    this.textContent = t;
  };
  (HTMLElement.prototype as any).createDiv = function (o: any = {}) {
    const el = document.createElement("div");
    if (o.cls) el.className = o.cls;
    if (o.text !== undefined) el.textContent = String(o.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createSpan = function (o: any = {}) {
    const el = document.createElement("span");
    if (o.cls) el.className = o.cls;
    if (o.text !== undefined) el.textContent = String(o.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createEl = function (tag: string, o: any = {}) {
    const el = document.createElement(tag);
    if (o.cls) el.className = o.cls;
    if (o.text !== undefined) el.textContent = String(o.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
});

describe("steer queued turn rendering", () => {
  it("renders main and queued steer turn as separate finalized bubbles and clears is-queued", async () => {
    const workspace = createConversationWorkspace("a", "session-a");
    const client: any = {
      sessionId: "session-a",
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
        setWorkspace: (v: any) => Object.assign(workspace, v),
      },
      readLocalHistory: async () => [],
    } as any);
    const plugin: any = {
      attachView: vi.fn(),
      getConversationControllerDependencies: vi.fn(),
      setConversationWorkspace: vi.fn(),
      getCurrentDocumentContext: vi.fn(),
      getCurrentMarkdownFilePath: vi.fn(),
      peekClient: vi.fn(() => undefined),
      getClient: vi.fn(() => client),
    };
    const view: any = new HermesianSidebarView(
      { app: { workspace: { layoutReady: false, onLayoutReady: vi.fn() } } } as any,
      plugin,
    );
    view.controller = controller;
    view.conversationWorkspace = workspace;
    view.composerDraft = { text: "", token: null, references: [] };
    view.includeCurrentDocumentContext = false;
    for (const name of [
      "hideSlashMenu",
      "renderAddConversationControl",
      "renderConversationTabs",
      "renderSessionState",
      "renderReadinessStatus",
      "renderCurrentFile",
      "renderSelectionBar",
      "renderImageAttachmentBar",
      "bindEscapeToStop",
      "bindStartupStatusRetry",
      "ensureStopAndSendCoordinator",
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
      "slashTokenEl",
      "slashTokenIconEl",
      "slashTokenLabelEl",
      "selectionBarEl",
      "imageAttachmentBarEl",
      "steerPendingRowEl",
      "steerPendingChipEl",
      "steerPendingIconEl",
      "steerPendingTextEl",
      "steerPendingStatusEl",
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
    ]) {
      view[name] = document.createElement("button");
    }
    const messagesEl = document.createElement("div");
    const renderer = new MessageRenderer(messagesEl);
    view.messageRenderer = renderer;
    view.turnManager = new TurnManager(renderer);
    view.controlAvailability = () =>
      ({ steer: true, send: true, composer: true }) as any;

    const container = renderer.containerFor("a");

    // 1. Main turn streams with messageId "m1"
    view.handleHermesEvent("a", {
      type: "assistant-delta",
      text: "这篇笔记讲了雅思 Task 1 方法论。",
      messageId: "m1",
    });
    await tick();

    // 2. Steer submitted while main turn still running -> queued
    view.composerDraft = {
      text: "算了，先回答我1+1=多少",
      token: null,
      references: [],
    };
    await view.steerActiveTurnFromComposer();
    await tick();
    expect(container.querySelector(".hermesian-steer-record.is-queued")).not.toBeNull();

    // 3. Main turn ends
    view.handleHermesEvent("a", { type: "turn-stop", reason: "end_turn" });
    await tick();

    // 4. Queued steer turn: thought, tool pending/completed, assistant-delta (messageId "m2")
    view.handleHermesEvent("a", { type: "thought-delta", text: "user asks 1+1" });
    view.handleHermesEvent("a", {
      type: "tool",
      id: "t1",
      title: "terminal: echo $((1+1))",
      kind: "execute",
      status: "pending",
      content: "",
    });
    view.handleHermesEvent("a", {
      type: "tool",
      id: "t1",
      title: "terminal: echo $((1+1))",
      kind: "execute",
      status: "completed",
      content: "2",
    });
    view.handleHermesEvent("a", {
      type: "assistant-delta",
      text: "1+1=2（已用 shell 实算确认）。",
      messageId: "m2",
    });
    await tick();

    // Steer turn started: queued marker is cleared
    expect(container.querySelector(".hermesian-steer-record.is-queued")).toBeNull();

    // 5. Usage finalize + late turn-stop
    view.handleHermesEvent("a", { type: "usage" });
    await tick();
    view.handleHermesEvent("a", { type: "turn-stop", reason: "end_turn" });
    await tick();

    const assistantMessages = Array.from(
      container.querySelectorAll(".hermesian-message.is-assistant"),
    );
    expect(assistantMessages).toHaveLength(2);

    expect(assistantMessages[0].textContent).toContain(
      "这篇笔记讲了雅思 Task 1 方法论。",
    );
    expect(assistantMessages[0].textContent).not.toContain("1+1=2");
    expect(assistantMessages[1].textContent).toContain("1+1=2");

    expect(container.querySelector(".hermesian-steer-record.is-queued")).toBeNull();

    for (const msg of assistantMessages) {
      const contentEl = msg.querySelector(".hermesian-message-content");
      expect(contentEl).not.toBeNull();
      expect(contentEl!.classList.contains("is-streaming")).toBe(false);
    }
  });
});
