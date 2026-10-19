import { readFileSync } from "node:fs";
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
  MarkdownRenderer: {
    render: vi.fn(async (_app: any, markdown: string, el: HTMLElement) => {
      el.textContent = markdown;
    }),
  },
  Notice: vi.fn(),
  setIcon: vi.fn(),
}));

import { HermesianSidebarView } from "../src/view";
import { MessageRenderer, TurnManager } from "../src/ui/message-renderer";

const stylesCss = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function getExactBlock(selector: string): string {
  const target = `\n${selector} {`;
  let start = stylesCss.indexOf(target);
  if (start < 0 && stylesCss.startsWith(`${selector} {`)) {
    start = 0;
  }
  expect(start).toBeGreaterThanOrEqual(0);
  const braceIndex = stylesCss.indexOf("{", start);
  const end = stylesCss.indexOf("}", braceIndex);
  expect(end).toBeGreaterThan(braceIndex);
  return stripComments(stylesCss.slice(braceIndex + 1, end));
}

function getKeyframesBlock(name: string): string {
  const target = `@keyframes ${name} {`;
  const start = stylesCss.indexOf(target);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = -1;
  for (let i = start; i < stylesCss.length; i++) {
    if (stylesCss[i] === "{") depth++;
    else if (stylesCss[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(start);
  return stripComments(stylesCss.slice(start, end + 1));
}

describe("styles.css Batch 3 Quiet Motion specifications", () => {
  it("defines spring and decel motion tokens in root/body variables", () => {
    const rootBlock = getExactBlock("body,\n.hermesian-view");
    expect(rootBlock).toMatch(/--hermesian-motion-spring:\s*cubic-bezier\(0\.34,\s*1\.3,\s*0\.64,\s*1\);/);
    expect(rootBlock).toMatch(/--hermesian-motion-decel:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\);/);
  });

  it("defines hermesian-bubble-enter keyframes with overshoot starting values", () => {
    const block = getKeyframesBlock("hermesian-bubble-enter");
    expect(block).toMatch(/from\s*\{[^}]*opacity:\s*0;/);
    expect(block).toMatch(/from\s*\{[^}]*transform:\s*translateY\(8px\)\s*scale\(0\.94\);/);
    expect(block).toMatch(/to\s*\{[^}]*opacity:\s*1;/);
    expect(block).toMatch(/to\s*\{[^}]*transform:\s*translateY\(0\)\s*scale\(1\);/);
  });

  it("defines hermesian-message-enter keyframes with fade-up starting values", () => {
    const block = getKeyframesBlock("hermesian-message-enter");
    expect(block).toMatch(/from\s*\{[^}]*opacity:\s*0;/);
    expect(block).toMatch(/from\s*\{[^}]*transform:\s*translateY\(12px\);/);
    expect(block).toMatch(/to\s*\{[^}]*opacity:\s*1;/);
    expect(block).toMatch(/to\s*\{[^}]*transform:\s*translateY\(0\);/);
  });

  it("defines hermesian-stream-reveal keyframes with blur and fade starting values", () => {
    const block = getKeyframesBlock("hermesian-stream-reveal");
    expect(block).toMatch(/from\s*\{[^}]*filter:\s*blur\(6px\);/);
    expect(block).toMatch(/from\s*\{[^}]*opacity:\s*0;/);
    expect(block).toMatch(/to\s*\{[^}]*filter:\s*blur\(0\);/);
    expect(block).toMatch(/to\s*\{[^}]*opacity:\s*1;/);
  });

  it("binds user message entrance animation with spring curve", () => {
    const block = getExactBlock(".hermesian-message.is-user.is-entering");
    expect(block).toMatch(/animation:\s*hermesian-bubble-enter\s+240ms\s+var\(--hermesian-motion-spring\)\s+both;/);
  });

  it("binds assistant message entrance animation with decel curve", () => {
    const block = getExactBlock(".hermesian-message.is-assistant.is-entering");
    expect(block).toMatch(/animation:\s*hermesian-message-enter\s+250ms\s+var\(--hermesian-motion-decel\)\s+both;/);
  });

  it("binds streaming text span reveal animation with backwards fill mode", () => {
    const block = getExactBlock(".hermesian-stream-reveal");
    expect(block).toMatch(/display:\s*inline;/);
    expect(block).toMatch(/animation:\s*hermesian-stream-reveal\s+350ms\s+ease-out\s+backwards;/);
  });

  it("upgrades button active scale feedback with spring curve", () => {
    const block = getExactBlock(".hermesian-view button");
    expect(block).toMatch(/transform\s+140ms\s+var\(--hermesian-motion-spring\);/);
  });

  it("upgrades picker popovers to CDS motionPopover spring entrance", () => {
    const modelPopover = getExactBlock(".hermesian-model-popover");
    expect(modelPopover).toMatch(/transform:\s*translateY\(4px\)\s*scale\(0\.95\);/);
    expect(modelPopover).toMatch(/opacity\s+200ms\s+var\(--hermesian-motion-decel\)/);
    expect(modelPopover).toMatch(/transform\s+200ms\s+var\(--hermesian-motion-spring\)/);

    const modelPopoverOpen = getExactBlock(".hermesian-model-popover--open");
    expect(modelPopoverOpen).toMatch(/transform:\s*translateY\(0\)\s*scale\(1\);/);

    const reasoningPopover = getExactBlock(".hermesian-reasoning-popover");
    expect(reasoningPopover).toMatch(/transform:\s*translateY\(4px\)\s*scale\(0\.95\);/);
    expect(reasoningPopover).toMatch(/opacity\s+200ms\s+var\(--hermesian-motion-decel\)/);
    expect(reasoningPopover).toMatch(/transform\s+200ms\s+var\(--hermesian-motion-spring\)/);

    const reasoningPopoverOpen = getExactBlock(".hermesian-reasoning-popover--open");
    expect(reasoningPopoverOpen).toMatch(/transform:\s*translateY\(0\)\s*scale\(1\);/);
  });

  it("disables motion under prefers-reduced-motion media query", () => {
    const target = "@media (prefers-reduced-motion: reduce) {";
    const start = stylesCss.indexOf(target);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = stylesCss.indexOf("/* ── Model picker popover", start);
    expect(end).toBeGreaterThan(start);
    const reducedBlock = stripComments(stylesCss.slice(start, end));

    expect(reducedBlock).toMatch(/\.hermesian-message\.is-entering,\s*\.hermesian-stream-reveal\s*\{/);
    expect(reducedBlock).toMatch(/animation:\s*none\s*!important;/);
    expect(reducedBlock).toMatch(/filter:\s*none\s*!important;/);
    expect(reducedBlock).toMatch(/transform:\s*none\s*!important;/);

    expect(reducedBlock).toMatch(/\.hermesian-model-popover,\s*\.hermesian-reasoning-popover\s*\{/);
    expect(reducedBlock).toMatch(/transition:\s*none\s*!important;/);
  });

  it("disables motion under .hermesian-reduced-motion body class", () => {
    const reducedBlock = getExactBlock(
      ".hermesian-reduced-motion .hermesian-message.is-entering,\n.hermesian-reduced-motion .hermesian-stream-reveal",
    );
    expect(reducedBlock).toMatch(/animation:\s*none;/);
    expect(reducedBlock).toMatch(/filter:\s*none;/);
    expect(reducedBlock).toMatch(/transform:\s*none;/);
  });

  it("does not introduce any hardcoded colors anywhere in styles.css", () => {
    const hardcodedColorPattern = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(/g;
    expect(stripComments(stylesCss).match(hardcodedColorPattern)).toBeNull();
  });
});

describe("Message entrance and streaming reveal behavior", () => {
  beforeEach(() => {
    const window = new Window();
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("Text", window.Text);
    vi.stubGlobal("Node", window.Node);

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
    (HTMLElement.prototype as any).setText = function (text: string) {
      this.textContent = text;
    };
    (HTMLElement.prototype as any).removeClass = function (cls: string) {
      this.classList.remove(cls);
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches .is-entering to live assistant message on first delta and wraps deltas in stream-reveal spans", () => {
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";
    const renderer = new MessageRenderer(messagesEl);
    renderer.show("tab-1");
    const turnManager = new TurnManager(renderer);

    turnManager.appendDelta("tab-1", "First chunk");

    const messageEl = messagesEl.querySelector<HTMLElement>(".hermesian-message.is-assistant");
    expect(messageEl).not.toBeNull();
    expect(messageEl?.classList.contains("is-entering")).toBe(true);

    const contentEl = messageEl?.querySelector<HTMLElement>(".hermesian-message-content");
    expect(contentEl?.classList.contains("is-streaming")).toBe(true);

    const spans = contentEl?.querySelectorAll(".hermesian-stream-reveal");
    expect(spans?.length).toBe(1);
    expect(spans?.[0].textContent).toBe("First chunk");

    // Second delta in the same turn
    turnManager.appendDelta("tab-1", " and second chunk");
    const spansAfter = contentEl?.querySelectorAll(".hermesian-stream-reveal");
    expect(spansAfter?.length).toBe(2);
    expect(spansAfter?.[1].textContent).toBe(" and second chunk");
    expect(contentEl?.textContent).toBe("First chunk and second chunk");

    // animationend event cleans up .is-entering
    messageEl?.dispatchEvent(new window.Event("animationend"));
    expect(messageEl?.classList.contains("is-entering")).toBe(false);
  });

  it("does not attach .is-entering to assistant message streaming in a background tab", () => {
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";
    const renderer = new MessageRenderer(messagesEl);
    // tab-1 is active/visible, tab-2 is in the background
    renderer.show("tab-1");
    const turnManager = new TurnManager(renderer);

    turnManager.appendDelta("tab-2", "Background chunk");

    const tab2Container = renderer.containerFor("tab-2");
    const messageEl = tab2Container.querySelector<HTMLElement>(".hermesian-message.is-assistant");
    expect(messageEl).not.toBeNull();
    expect(messageEl?.classList.contains("is-entering")).toBe(false);
  });

  it("attaches .is-entering to live user message when animate is requested and cleans up on animationend", () => {
    const parent = document.createElement("div");
    const view = Object.create(HermesianSidebarView.prototype);
    view.messageContainer = () => parent;
    view.messagesEl = parent;
    view.scrollToBottom = vi.fn();

    // Call private appendUserMessage with animate: true
    const userMessage: HTMLElement = (view as any).appendUserMessage(
      "Hello Hermes",
      undefined,
      undefined,
      "tab-1",
      [],
      undefined,
      { animate: true },
    );

    expect(userMessage.classList.contains("is-user")).toBe(true);
    expect(userMessage.classList.contains("is-entering")).toBe(true);

    // animationend removes .is-entering
    userMessage.dispatchEvent(new window.Event("animationend"));
    expect(userMessage.classList.contains("is-entering")).toBe(false);
  });

  it("does not attach .is-entering to user message in a background tab even if animate: true", () => {
    const parent = document.createElement("div");
    const view = Object.create(HermesianSidebarView.prototype);
    view.messageContainer = () => parent;
    view.messagesEl = parent;
    view.scrollToBottom = vi.fn();
    view.conversationWorkspace = { activeTabId: "tab-1", tabs: [] };

    // Send to tab-2 while tab-1 is active
    const userMessage: HTMLElement = (view as any).appendUserMessage(
      "Hello from background",
      undefined,
      undefined,
      "tab-2",
      [],
      undefined,
      { animate: true },
    );

    expect(userMessage.classList.contains("is-user")).toBe(true);
    expect(userMessage.classList.contains("is-entering")).toBe(false);
  });

  it("removes .is-entering via timeout fallback if animationend is never dispatched", () => {
    vi.useFakeTimers();
    try {
      const parent = document.createElement("div");
      const view = Object.create(HermesianSidebarView.prototype);
      view.messageContainer = () => parent;
      view.messagesEl = parent;
      view.scrollToBottom = vi.fn();

      const userMessage: HTMLElement = (view as any).appendUserMessage(
        "Hello Hermes",
        undefined,
        undefined,
        "tab-1",
        [],
        undefined,
        { animate: true },
      );

      expect(userMessage.classList.contains("is-entering")).toBe(true);

      // Do NOT dispatch animationend; advance timer past fallback
      vi.advanceTimersByTime(300);
      expect(userMessage.classList.contains("is-entering")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes { animate: true } to appendUserMessage on the production send path", async () => {
    const tab = { id: "tab-1", sessionId: "sess-1", title: "Chat" };
    const client = {
      sessionId: "sess-1",
      sendPrompt: vi.fn().mockResolvedValue(undefined),
    };
    const view = Object.create(HermesianSidebarView.prototype);
    view.conversationWorkspace = { activeTabId: "tab-1", tabs: [tab] };
    view.activeConversationTab = () => tab;
    view.controller = {
      getSnapshot: () => ({
        tabOperations: new Map([["tab-1", { connection: "ready" }]]),
      }),
      setPromptRunning: vi.fn(),
    };
    view.controlAvailability = () => ({ send: true });
    view.isStopping = () => false;
    view.isTabBusy = () => false;
    view.isTabLoading = () => false;
    view.hasPendingPermission = () => false;
    view.historyRendering = new Map();
    view.composerDraft = { token: null, text: "Send live message", references: [] };
    view.pendingImages = new Map();
    view.editScopes = new Map();
    view.tabSelections = new Map();
    view.noteContextFingerprints = new Map();
    view.plugin = {
      getClient: () => client,
      setConversationWorkspace: vi.fn(),
    };
    view.turnRuntime = () => ({ busy: false, toolEls: new Map() });
    view.messageContainer = () => document.createElement("div");
    view.resetStreamingMessage = vi.fn();
    view.clearQueuedSteers = vi.fn();
    view.renderConversationTabs = vi.fn();
    view.updateControls = vi.fn();
    view.setComposerSlashToken = vi.fn();
    view.renderComposerInlineDraft = vi.fn();
    view.hideSlashMenu = vi.fn();
    view.renderSelectionBar = vi.fn();
    view.renderImageAttachmentBar = vi.fn();
    view.captureActiveConversationRuntime = vi.fn();
    view.loadedMessageTabIds = new Set();
    view.appendUserMessage = vi.fn();

    await (view as any).sendMessage();

    expect(view.appendUserMessage).toHaveBeenCalledWith(
      "Send live message",
      undefined,
      undefined,
      "tab-1",
      [],
      undefined,
      { animate: true },
    );
  });

  it("does not attach .is-entering during history replay", async () => {
    const parent = document.createElement("div");
    const view = Object.create(HermesianSidebarView.prototype);
    view.messageContainer = () => parent;
    view.messagesEl = parent;
    view.scrollToBottom = vi.fn();
    view.attachMessageCopyButton = vi.fn();
    view.renderMarkdown = vi.fn(async () => undefined);

    // 1. History replay user message (animate not passed)
    const historyUserMsg: HTMLElement = (view as any).appendUserMessage(
      "Historical prompt",
      undefined,
      undefined,
      "tab-1",
    );
    expect(historyUserMsg.classList.contains("is-entering")).toBe(false);

    // 2. History replay assistant message via renderHistoryTurn
    await (view as any).renderHistoryTurn(
      [{ kind: "assistant", text: "Historical response" }],
      "tab-1",
    );

    const historyAssistantMsg = parent.querySelector(".hermesian-message.is-assistant");
    expect(historyAssistantMsg).not.toBeNull();
    expect(historyAssistantMsg?.classList.contains("is-entering")).toBe(false);
  });

  it("cleans up streaming spans and .is-streaming upon finalizing assistant message", async () => {
    const messagesEl = document.createElement("div");
    const renderer = new MessageRenderer(messagesEl);
    renderer.show("tab-1");
    const turnManager = new TurnManager(renderer);

    turnManager.appendDelta("tab-1", "Streaming line 1");
    turnManager.appendDelta("tab-1", "\nStreaming line 2");

    const messageEl = messagesEl.querySelector<HTMLElement>(".hermesian-message.is-assistant");
    const contentEl = messageEl?.querySelector<HTMLElement>(".hermesian-message-content");
    expect(contentEl?.classList.contains("is-streaming")).toBe(true);
    expect(contentEl?.querySelectorAll(".hermesian-stream-reveal").length).toBe(2);

    // Mock view finalizeAssistantMessage flow
    const view = Object.create(HermesianSidebarView.prototype);
    view.app = {};
    view.turnRuntime = () => turnManager.ensure("tab-1");
    view.editScopes = new Map();
    view.scrollToBottom = vi.fn();

    await (view as any).finalizeAssistantMessage("tab-1");

    // After finalize: is-streaming removed, spans emptied and replaced with rendered text
    expect(contentEl?.classList.contains("is-streaming")).toBe(false);
    expect(contentEl?.querySelectorAll(".hermesian-stream-reveal").length).toBe(0);
    expect(contentEl?.textContent).toBe("Streaming line 1\nStreaming line 2");
  });
});
