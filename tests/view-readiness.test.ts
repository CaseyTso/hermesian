import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  ItemView: class { app: any; containerEl = document.createElement("div"); constructor(leaf: any) { this.app = leaf.app; } },
  Modal: class {},
  SuggestModal: class {}, MarkdownView: class {}, WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn(async () => undefined) },
  Notice: vi.fn(), setIcon: vi.fn(),
}));
import { HermesianSidebarView } from "../src/view";
import { ConversationController } from "../src/conversation-controller";
import { createConversationWorkspace, addConversationTab, updateConversationTab } from "../src/conversation-tabs";
import { PendingSendStore } from "../src/pending-send";
import { MessageRenderer, TurnManager } from "../src/ui/message-renderer";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  (HTMLElement.prototype as any).show = function () { this.style.display = ""; };
  (HTMLElement.prototype as any).hide = function () { this.style.display = "none"; };
  (HTMLElement.prototype as any).setText = function (text: string) { this.textContent = text; };
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

function viewHarness(options: { readLocalHistory?: () => Promise<any[]> } = {}) {
  let workspace = createConversationWorkspace("a", "session-a");
  workspace = addConversationTab(workspace, "b", "session-b");
  workspace.activeTabId = "a";
  workspace = updateConversationTab(workspace, "a", { draft: "saved draft", includeCurrentDocumentContext: false });
  const ready = deferred<any[]>();
  const client: any = {
    sessionId: "session-a", connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined), loadSessionHistory: vi.fn(() => ready.promise),
    steerActiveTurn: vi.fn(async () => ({ ok: false, reason: "queued" })),
    sendPrompt: vi.fn(async () => undefined),
  };
  const controller = new ConversationController({
    clients: { acquireClient: () => client, getClient: () => client, isCurrentClient: () => true, releaseClient: async () => undefined },
    workspace: { getWorkspace: () => workspace, setWorkspace: (value) => { workspace = value; } },
    readLocalHistory: options.readLocalHistory ?? (async () => [{ kind: "user", text: "local readable" }]),
  });
  const plugin = {
    attachView: vi.fn(),
    getConversationControllerDependencies: vi.fn(),
    setConversationWorkspace: vi.fn((value) => { workspace = value; }),
    getCurrentDocumentContext: vi.fn(), getCurrentMarkdownFilePath: vi.fn(),
    peekClient: vi.fn(() => undefined),
    getClient: vi.fn(() => client),
  };
  const app = { workspace: { layoutReady: false, onLayoutReady: vi.fn() } };
  const view: any = new HermesianSidebarView({ app } as any, plugin as any);
  view.controller = controller;
  view.conversationWorkspace = workspace;
  view.composerDraft = { text: "saved draft", token: null, references: [] };
  view.includeCurrentDocumentContext = false;
  view.turnManager = {
    isBusy: () => false,
    clearQueuedSteers: () => undefined,
    appendSteer: () => undefined,
  };
  for (const name of ["hideSlashMenu", "renderAddConversationControl", "renderConversationTabs", "renderSessionState", "renderReadinessStatus",
    "renderCurrentFile", "renderSelectionBar", "renderImageAttachmentBar", "bindEscapeToStop", "bindStartupStatusRetry", "ensureStopAndSendCoordinator"]) {
    view[name] = vi.fn();
  }
  view.composerPlaceholder = () => "Ask Hermes";
  for (const name of [
    "composerEl", "composerStatusEl", "composerHintEl", "filePickerMenuEl",
    "statusEl", "steerModeEl", "slashTokenEl", "slashTokenIconEl",
    "slashTokenLabelEl", "selectionBarEl", "imageAttachmentBarEl",
  ]) view[name] = document.createElement("div");
  view.steerModeEl.hide();
  for (const name of ["sendButtonEl", "stopButtonEl", "steerButtonEl", "dictationButtonEl", "filePickerButtonEl", "historyButtonEl", "reasoningButtonEl"]) view[name] = document.createElement("button");
  view.showConversationMessages = vi.fn();
  view.applyComposerCanonicalDraft = vi.fn((text: string) => { view.composerDraft = { text, token: null, references: [] }; });
  view.renderHistorySession = vi.fn(async () => undefined);
  view.seedNoteContextFingerprint = vi.fn();
  view.controllerUnsubscribe = controller.subscribe((snapshot) => view.handleControllerSnapshot(snapshot));
  return { view, controller, plugin, ready, client, app };
}

describe("readiness view interaction", () => {
  it("onOpen exposes saved tabs/draft and local history while layout and ACP are still pending", async () => {
    const h = viewHarness();
    h.view.renderShell = vi.fn();
    await h.view.onOpen();
    expect(h.view.showConversationMessages).toHaveBeenCalledWith("a");
    expect(h.view.composerDraft.text).toBe("saved draft");
    expect(h.view.composerEl.contentEditable).toBe("true");
    expect(h.view.renderConversationTabs).toHaveBeenCalled();
    await tick();
    expect(h.client.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.view.renderHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a" }), [{ kind: "user", text: "local readable" }], false, "a", expect.any(Function),
    );
    h.view.startup.close();
  });

  it("accepts one pending send, locks only its composer and sends the snapshot exactly once after readiness", async () => {
    const h = viewHarness();
    const dispatch = vi.spyOn(h.view, "sendMessage").mockResolvedValue(undefined);
    const first = h.view.waitToSend("a");
    const duplicate = h.view.waitToSend("a");
    expect(h.view.composerEl.contentEditable).toBe("false");
    expect(h.view.stopButtonEl.getAttribute("aria-label")).toBe("Cancel pending send");
    expect(h.view.composerStatusEl.textContent).toContain("Waiting for connection");
    expect(h.view.composerDraft.text).toBe("saved draft");
    expect(dispatch).not.toHaveBeenCalled();
    await h.controller.switchConversation("b");
    h.view.restoreActiveConversationRuntime();
    h.view.updateControls(false);
    expect(h.view.composerEl.contentEditable).toBe("true");
    h.ready.resolve([]);
    await Promise.all([first, duplicate]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ pending: expect.objectContaining({ tabId: "a", draft: expect.objectContaining({ text: "saved draft" }) }) });
    expect(h.plugin.getCurrentDocumentContext).not.toHaveBeenCalled();
    expect(h.plugin.getCurrentMarkdownFilePath).not.toHaveBeenCalled();
    await tick();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("dispatches a ready background intent through the real send path without touching the visible draft", async () => {
    const h = viewHarness();
    const sendPrompt = vi.fn(async (_prompt: unknown) => undefined);
    (h.plugin as any).getClient = vi.fn(() => ({ ...h.client, sendPrompt }));
    h.view.turnRuntime = () => ({ busy: false });
    h.view.messageContainer = () => ({ createDiv: () => ({}) });
    h.view.resetStreamingMessage = vi.fn();
    h.view.appendUserMessage = vi.fn();
    const sending = h.view.waitToSend("a");
    await h.controller.switchConversation("b");
    h.view.composerDraft = { text: "B continued typing", token: null, references: [] };
    h.view.captureActiveConversationRuntime();
    h.ready.resolve([]);
    await sending;
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(String(sendPrompt.mock.calls[0]?.[0])).toContain("saved draft");
    expect(h.view.composerDraft.text).toBe("B continued typing");
    expect(h.view.conversationWorkspace.tabs.find((tab: any) => tab.id === "b").draft).toBe("B continued typing");
    expect(h.view.conversationWorkspace.tabs.find((tab: any) => tab.id === "a").draft).toBe("");
    expect(h.view.appendUserMessage.mock.calls[0]?.[3]).toBe("a");
  });

  it("Stop cancels only the pending intent, retains draft and images, and ignores late readiness", async () => {
    const h = viewHarness();
    const image = { id: "image", dataUrl: "data:image/png;base64,test" };
    h.view.pendingImages.set("a", [image]);
    const dispatch = vi.spyOn(h.view, "sendMessage").mockResolvedValue(undefined);
    const sending = h.view.waitToSend("a");
    await h.view.handleComposerStop();
    expect(h.view.composerEl.contentEditable).toBe("true");
    expect(h.view.composerDraft.text).toBe("saved draft");
    expect(h.view.pendingImages.get("a")).toEqual([image]);
    h.ready.resolve([]);
    await sending;
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.client.disconnect).not.toHaveBeenCalled();
  });

  it("pending intent freezes reference/context metadata and rejects paste edits until cancelled", async () => {
    const h = viewHarness();
    h.view.composerDraft = { token: null, text: "/vault/file.md", references: [{ kind: "file", value: "/vault/file.md", start: 0 }] };
    const before = structuredClone(h.view.composerDraft);
    const dispatch = vi.spyOn(h.view, "sendMessage").mockResolvedValue(undefined);
    const sending = h.view.waitToSend("a");
    h.view.removeComposerReference(0);
    h.view.setSelection({ filePath: "not-attached" });
    const paste = { preventDefault: vi.fn() };
    await h.view.handleComposerPaste(paste);
    expect(paste.preventDefault).toHaveBeenCalledOnce();
    expect(h.view.composerDraft).toEqual(before);
    expect(h.view.pendingSelection).toBeUndefined();
    await h.view.handleComposerStop();
    h.ready.resolve([]);
    await sending;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("failure unlocks and retains all content, with no automatic send on a later retry", async () => {
    const h = viewHarness();
    const dispatch = vi.spyOn(h.view, "sendMessage").mockResolvedValue(undefined);
    const sending = h.view.waitToSend("a");
    h.ready.reject(new Error("offline"));
    await sending;
    expect(h.view.composerEl.contentEditable).toBe("true");
    expect(h.view.composerDraft.text).toBe("saved draft");
    expect(h.view.composerHint).toContain("Message retained");
    expect(h.view.pendingSends.has("a")).toBe(false);
    h.client.loadSessionHistory = vi.fn(async () => []);
    await h.controller.ensureConversationReady("a");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("late onClose completion cannot clear a reopened controller", async () => {
    const h = viewHarness();
    const persist = deferred<void>();
    (h.plugin as any).flushConversationWorkspace = vi.fn(() => persist.promise);
    (h.plugin as any).releaseView = vi.fn(async () => undefined);
    h.view.teardownDictationRecording = vi.fn();
    const closing = h.view.onClose();
    expect(h.view.controller).toBeUndefined();
    expect((h.plugin as any).releaseView).toHaveBeenCalledOnce();
    const reopenedController = { marker: "new controller" };
    h.view.controller = reopenedController;
    h.view.viewClosed = false;
    h.view.viewEpoch += 1;
    persist.resolve();
    await closing;
    expect(h.view.controller).toBe(reopenedController);
    expect(h.view.viewClosed).toBe(false);
  });

  it("late history rendering cannot apply after closing/reopening a view epoch", async () => {
    const h = viewHarness();
    const renderGate = deferred<void>();
    h.view.historyRendering.set("a", renderGate.promise);
    await h.controller.readAvailableHistory("a");
    h.view.viewEpoch += 1;
    renderGate.resolve();
    await tick();
    expect(h.view.renderHistorySession).not.toHaveBeenCalled();
  });
});

describe("PendingSendStore ownership", () => {
  it("a cancelled/replaced entry cannot consume a newer send for the same tab", () => {
    const store = new PendingSendStore<string>();
    const old = store.add("a", "old")!;
    expect(store.add("a", "duplicate")).toBeUndefined();
    store.cancel("a");
    const next = store.add("a", "next")!;
    expect(store.take("a", old)).toBeUndefined();
    expect(store.take("a", next)).toBe("next");
    expect(store.take("a", next)).toBeUndefined();
  });
});

describe("steer record view integration (F1, F5, F6, G6)", () => {
  it("drives steer path with queued result, records in DOM, and clears marker on real next turn (F5)", async () => {
    const h = viewHarness({ readLocalHistory: async () => [] });
    const activeTabId = h.view.conversationWorkspace.activeTabId; // "a"

    const messagesEl = document.createElement("div");
    const renderer = new MessageRenderer(messagesEl);
    const turnManager = new TurnManager(renderer);
    h.view.messageRenderer = renderer;
    h.view.turnManager = turnManager;

    // Set up active turn so appendSteer does not early-return (F1)
    const oldActivity = turnManager.ensureActivity(activeTabId);
    expect(oldActivity).toBeDefined();
    const runtime = (h.view as any).turnRuntime(activeTabId);
    const oldTurnEl = runtime.activeTurnEl;

    // Set up steerable composer state and stubbed queued steer RPC response
    h.view.composerDraft = { text: "Fix this async bug", token: null, references: [] };
    h.view.controlAvailability = () => ({ steer: true, send: true, composer: true } as any);
    h.client.steerActiveTurn.mockResolvedValueOnce({ ok: false, reason: "queued" });

    // Drive the steer path through the view method (view.ts:2440-2485)
    await (h.view as any).steerActiveTurnFromComposer();

    expect(h.client.steerActiveTurn).toHaveBeenCalledWith("Fix this async bug");

    // Assert a .hermesian-steer-record.is-queued exists in tab's DOM
    const container = h.view.messageRenderer.containerFor(activeTabId);
    const queuedRecord = container.querySelector(".hermesian-steer-record.is-queued");
    expect(queuedRecord).not.toBeNull();
    expect(queuedRecord!.querySelector(".hermesian-steer-marker")?.textContent).toContain("queued for next turn");
    expect(queuedRecord!.querySelector(".hermesian-steer-content")?.textContent).toBe("Fix this async bug");

    // Drive the real next-turn block through waitToSend and resolving readiness deferred
    h.view.composerDraft = { text: "Next turn follow-up", token: null, references: [] };
    const sending = (h.view as any).waitToSend(activeTabId);
    h.ready.resolve([]);
    await sending;

    // Assert the marker is gone
    expect(container.querySelector(".hermesian-steer-record.is-queued")).toBeNull();
    expect(queuedRecord!.classList.contains("is-queued")).toBe(false);
    expect(queuedRecord!.querySelector(".hermesian-steer-marker")).toBeNull();
    expect(queuedRecord!.querySelector("summary")?.textContent).toBe("Steer");
    expect(queuedRecord!.querySelector(".hermesian-steer-content")?.textContent).toBe("Fix this async bug");

    // Assert that ensureActivity returns an element inside the NEW activeTurnEl, not oldTurnEl
    const newTurnEl = runtime.activeTurnEl;
    expect(newTurnEl).toBeDefined();
    expect(newTurnEl).not.toBe(oldTurnEl);
    const newActivity = turnManager.ensureActivity(activeTabId);
    expect(newTurnEl.contains(newActivity)).toBe(true);
    expect(oldTurnEl.contains(newActivity)).toBe(false);
  });

  it("guards against resurrecting steer records when tab is closed or view is closed (F6)", () => {
    const h = viewHarness();

    const messagesEl = document.createElement("div");
    const renderer = new MessageRenderer(messagesEl);
    const turnManager = new TurnManager(renderer);
    h.view.messageRenderer = renderer;
    h.view.turnManager = turnManager;

    // Ensure live turns exist in TurnManager so guards are genuinely exercised (G3)
    turnManager.ensureActivity("non-existent-tab");
    turnManager.ensureActivity("a");

    // 1. Tab not in conversationWorkspace.tabs
    const resTabClosed = (h.view as any).appendSteerRecord("non-existent-tab", "late steer", false);
    expect(resTabClosed).toBeUndefined();

    // 2. View closed
    h.view.viewClosed = true;
    const resViewClosed = (h.view as any).appendSteerRecord("a", "late steer", false);
    expect(resViewClosed).toBeUndefined();

    // Neither container received a steer record
    expect(renderer.containerFor("a").querySelector(".hermesian-steer-record")).toBeNull();
    expect(renderer.containerFor("non-existent-tab").querySelector(".hermesian-steer-record")).toBeNull();
  });

  it("clears turnActivityEl when starting next turn to prevent orphan turn scaffold (F1)", async () => {
    const h = viewHarness({ readLocalHistory: async () => [] });
    const messagesEl = document.createElement("div");
    const renderer = new MessageRenderer(messagesEl);
    const turnManager = new TurnManager(renderer);
    h.view.messageRenderer = renderer;
    h.view.turnManager = turnManager;

    const activeTabId = "a";
    // Set up live turn scaffold pointing to an active turn element
    const oldActivityEl = turnManager.ensureActivity(activeTabId);
    const runtime = (h.view as any).turnRuntime(activeTabId);
    const oldTurnEl = runtime.activeTurnEl;
    expect(oldTurnEl).toBeDefined();
    expect(oldTurnEl.contains(oldActivityEl)).toBe(true);

    // Drive the REAL next-turn path through waitToSend + readiness resolution (G4)
    h.view.composerDraft = { text: "Next prompt text", token: null, references: [] };
    const sending = (h.view as any).waitToSend(activeTabId);
    h.ready.resolve([]);
    await sending;

    const newTurnEl = runtime.activeTurnEl;
    expect(newTurnEl).toBeDefined();
    expect(newTurnEl).not.toBe(oldTurnEl);

    // When next activity is requested, it must be created in the new turn, not the old one
    const newActivity = turnManager.ensureActivity(activeTabId);
    expect(newTurnEl.contains(newActivity)).toBe(true);
    expect(oldTurnEl.contains(newActivity)).toBe(false);
  });

  it("toggles steerModeEl visibility based on control availability (G6)", () => {
    const h = viewHarness();

    // Stub control availability for steer mode
    h.view.controlAvailability = () => ({ steer: true, stop: true, send: false, composer: true } as any);
    h.view.updateControls(false);

    expect(h.view.steerModeEl.style.display).not.toBe("none");

    // Flip availability to send mode
    h.view.controlAvailability = () => ({ steer: false, stop: false, send: true, composer: true } as any);
    h.view.updateControls(false);

    expect(h.view.steerModeEl.style.display).toBe("none");
  });
});
