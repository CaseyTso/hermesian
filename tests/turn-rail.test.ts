import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  ItemView: class {
    app: any;
    containerEl = document.createElement("div");
    constructor(leaf: any) {
      this.app = leaf?.app;
    }
  },
  Modal: class {},
  SuggestModal: class {},
  MarkdownView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn(async () => undefined) },
  Notice: vi.fn(),
  setIcon: vi.fn((el: HTMLElement, iconName: string) => {
    el.setAttribute("data-icon", iconName);
  }),
}));

import { HermesianSidebarView } from "../src/view";
import { MessageRenderer } from "../src/ui/message-renderer";
import { ScrollFollowController } from "../src/ui/scroll-lock";
import { TurnRail, MAX_PREVIEW_CHARS } from "../src/ui/turn-rail";

const stylesCss = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function getBlock(selector: string): string {
  const target = `${selector} {`;
  const start = stylesCss.lastIndexOf(target);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = stylesCss.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return stripComments(stylesCss.slice(start, end));
}

function setupDOM() {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("MouseEvent", window.MouseEvent);

  (HTMLElement.prototype as any).addClass = function (cls: string) {
    this.classList.add(cls);
  };
  (HTMLElement.prototype as any).removeClass = function (cls: string) {
    this.classList.remove(cls);
  };
  (HTMLElement.prototype as any).createDiv = function (options: any = {}) {
    const el = document.createElement("div");
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = String(options.text);
    if (options.attr) {
      for (const [k, v] of Object.entries(options.attr)) {
        el.setAttribute(k, String(v));
      }
    }
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createSpan = function (options: any = {}) {
    return (this as any).createEl("span", options);
  };
  (HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = String(options.text);
    if (options.attr) {
      for (const [k, v] of Object.entries(options.attr)) {
        el.setAttribute(k, String(v));
      }
    }
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };

  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  };
}

function setupTurnRailFixture(options: {
  clientHeight?: number;
  thresholdPx?: number;
} = {}) {
  const hostEl = document.createElement("div");
  hostEl.className = "hermesian-messages-container";
  const messagesEl = hostEl.createDiv({ cls: "hermesian-messages" });

  const clientHeight = options.clientHeight ?? 300;
  Object.defineProperty(messagesEl, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(messagesEl, "scrollHeight", {
    configurable: true,
    writable: true,
    value: clientHeight,
  });
  messagesEl.scrollTop = 0;

  const scrollFollow = new ScrollFollowController({
    thresholdPx: options.thresholdPx ?? 40,
  });
  const onScrollToBottom = vi.fn();

  const rail = new TurnRail({
    dotPitch: 14,
    hostEl,
    messagesEl,
    onScrollToBottom,
    scrollFollow,
  });

  return { hostEl, messagesEl, onScrollToBottom, rail, scrollFollow };
}

describe("Turn Rail - styles.css visual contract", () => {
  it("defines .hermesian-turn-rail as narrow overlay on the right with default low opacity", () => {
    const block = getBlock(".hermesian-turn-rail");
    expect(block).toMatch(/position:\s*absolute;/);
    expect(block).toMatch(/right:\s*2px;/);
    expect(block).toMatch(/opacity:\s*0\.35;/);
    expect(block).toMatch(/width:\s*20px;/);
    expect(block).toMatch(/transition:\s*opacity var\(--hermesian-motion\);/);
  });

  it("defines full opacity on .hermesian-turn-rail:hover", () => {
    const block = getBlock(".hermesian-turn-rail:hover");
    expect(block).toMatch(/opacity:\s*1;/);
  });

  it("defines .hermesian-turn-rail-dot as subtle circular button", () => {
    const block = getBlock(".hermesian-turn-rail-dot");
    expect(block).toMatch(/border-radius:\s*50%;/);
    expect(block).toMatch(/width:\s*6px;/);
    expect(block).toMatch(/height:\s*6px;/);
    expect(block).toMatch(/background:\s*var\(--text-faint\);/);
  });

  it("defines .hermesian-turn-rail-dot.is-current with prominent text-normal color", () => {
    const block = getBlock(".hermesian-turn-rail-dot.is-current");
    expect(block).toMatch(/background:\s*var\(--text-normal\);/);
  });

  it("defines .hermesian-turn-rail-dot.is-working with hermesian-pulse keyframe animation", () => {
    const block = getBlock(".hermesian-turn-rail-dot.is-working");
    expect(block).toMatch(/animation:\s*hermesian-pulse 1\.8s ease-in-out infinite;/);
    expect(block).toMatch(/background:\s*var\(--hermesian-accent,\s*var\(--interactive-accent\)\);/);
  });

  it("defines @keyframes hermesian-pulse", () => {
    expect(stylesCss).toContain("@keyframes hermesian-pulse");
    const start = stylesCss.indexOf("@keyframes hermesian-pulse {");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = stylesCss.indexOf("}", stylesCss.indexOf("}", start) + 1);
    expect(end).toBeGreaterThan(start);
  });

  it("defines .hermesian-back-to-bottom as circular floating button with shadow and theme border", () => {
    const block = getBlock(".hermesian-back-to-bottom");
    expect(block).toMatch(/position:\s*absolute;/);
    expect(block).toMatch(/border-radius:\s*50%;/);
    expect(block).toMatch(/background:\s*var\(--background-secondary\);/);
    expect(block).toMatch(/border:\s*1px solid var\(--background-modifier-border\);/);
    expect(block).toMatch(/box-shadow:\s*var\(--hermesian-shadow-sm\);/);
  });

  it("contains no hardcoded colors in Turn Rail styles", () => {
    const start = stylesCss.indexOf(".hermesian-turn-rail {");
    const end = stylesCss.indexOf(".hermesian-turn,\n.hermesian-turn-activity {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const rules = stripComments(stylesCss.slice(start, end));
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});

describe("Turn Rail - Component behavior", () => {
  beforeEach(() => {
    setupDOM();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Visibility threshold (< 2 turns hidden)", () => {
    it("is hidden when tab has 0 turns", () => {
      const { rail } = setupTurnRailFixture();
      rail.switchTab("tab-1");
      expect(rail.railEl.classList.contains("is-hidden")).toBe(true);
    });

    it("is hidden when tab has only 1 turn", () => {
      const { rail, messagesEl } = setupTurnRailFixture();
      rail.switchTab("tab-1");
      const msg = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg, "Hello first turn");

      expect(rail.railEl.classList.contains("is-hidden")).toBe(true);
    });

    it("becomes visible when tab reaches 2 turns", () => {
      const { rail, messagesEl } = setupTurnRailFixture();
      rail.switchTab("tab-1");
      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg1, "First user message");

      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg2, "Second user message");

      expect(rail.railEl.classList.contains("is-hidden")).toBe(false);
      const dots = rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot");
      expect(dots.length).toBe(2);
    });
  });

  describe("Turn creation (Real-time and History replay)", () => {
    it("generates dots and associates turn responses for real-time messages", () => {
      const { rail, messagesEl } = setupTurnRailFixture();
      rail.switchTab("tab-1");

      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg1, "What is TypeScript?");
      const turn1 = messagesEl.createDiv({ cls: "hermesian-turn" });
      rail.registerTurn("tab-1", turn1);

      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg2, "How do generics work?");
      const turn2 = messagesEl.createDiv({ cls: "hermesian-turn" });
      rail.registerTurn("tab-1", turn2);

      const turns = rail.getTurns("tab-1");
      expect(turns.length).toBe(2);
      expect(turns[0].turnEl).toBe(turn1);
      expect(turns[1].turnEl).toBe(turn2);

      const dots = rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot");
      expect(dots.length).toBe(2);
    });

    it("generates dots for history replay turns via View integration", async () => {
      const parent = document.createElement("div");
      const messagesContainer = parent.createDiv({ cls: "hermesian-messages-container" });
      const messagesEl = messagesContainer.createDiv({ cls: "hermesian-messages" });
      const renderer = new MessageRenderer(messagesEl as HTMLElement);
      renderer.show("tab-hist");

      const scrollFollow = new ScrollFollowController();
      const rail = new TurnRail({
        hostEl: messagesContainer,
        messagesEl: messagesEl as HTMLElement,
        scrollFollow,
      });
      rail.switchTab("tab-hist");

      const view = Object.create(HermesianSidebarView.prototype) as any;
      view.turnRail = rail;
      view.messageRenderer = renderer;
      view.scrollToBottom = vi.fn();
      view.messageContainer = () => renderer.containerFor("tab-hist");
      view.tabFirstUserMessages = new Map();
      view.stripUserPromptForDisplay = (t: string) => t;

      // Replay 2 history turns
      const userMsg1 = view.appendUserMessage("History prompt 1", undefined, undefined, "tab-hist");
      await view.renderHistoryTurn([{ kind: "assistant", text: "Answer 1" }], "tab-hist");

      const userMsg2 = view.appendUserMessage("History prompt 2", undefined, undefined, "tab-hist");
      await view.renderHistoryTurn([{ kind: "assistant", text: "Answer 2" }], "tab-hist");

      const turns = rail.getTurns("tab-hist");
      expect(turns.length).toBe(2);
      expect(turns[0].userMessageEl).toBe(userMsg1);
      expect(turns[1].userMessageEl).toBe(userMsg2);

      const dots = rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot");
      expect(dots.length).toBe(2);
    });
  });

  describe("Hover preview and Active Turn pulse", () => {
    it("displays truncated preview tooltip on hover", () => {
      const { rail, messagesEl } = setupTurnRailFixture();
      rail.switchTab("tab-1");

      const longPrompt = "This is a very long prompt that definitely exceeds the 40 character limit for preview.";
      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg1, longPrompt);

      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg2, "Short prompt");

      const dots = rail.trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");
      const firstDot = dots[0];
      const previewText = firstDot.getAttribute("data-preview");

      expect(previewText).toBe(`${longPrompt.slice(0, MAX_PREVIEW_CHARS)}…`);
      expect(firstDot.getAttribute("title")).toBe(previewText);

      // Mouseenter shows tooltip
      firstDot.dispatchEvent(new MouseEvent("mouseenter"));
      expect(rail.tooltipEl.classList.contains("is-hidden")).toBe(false);
      expect(rail.tooltipEl.textContent).toBe(previewText);

      // Mouseleave hides tooltip
      firstDot.dispatchEvent(new MouseEvent("mouseleave"));
      expect(rail.tooltipEl.classList.contains("is-hidden")).toBe(true);
    });

    it("applies .is-working pulse to active turn dot and removes it when turn completes", () => {
      const { rail, messagesEl } = setupTurnRailFixture();
      rail.switchTab("tab-1");

      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg1, "First query");
      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg2, "Second query running");

      // Mark latest turn as active
      rail.setActiveTurn("tab-1", true);

      let dots = rail.trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");
      expect(dots[0].classList.contains("is-working")).toBe(false);
      expect(dots[1].classList.contains("is-working")).toBe(true);

      // Complete turn
      rail.setActiveTurn("tab-1", false);
      dots = rail.trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");
      expect(dots[1].classList.contains("is-working")).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("dynamically computes page size from messagesEl height", () => {
      // 140px height: available = 140 - 32 = 108px -> Math.floor(108 / 14) = 7
      const fixtureSmall = setupTurnRailFixture({ clientHeight: 140 });
      expect(fixtureSmall.rail.calculatePageSize()).toBe(7);

      // 280px height: available = 280 - 32 = 248px -> Math.floor(248 / 14) = 17
      const fixtureLarge = setupTurnRailFixture({ clientHeight: 280 });
      expect(fixtureLarge.rail.calculatePageSize()).toBe(17);
    });

    it("shows up arrow when older turns exceed the current page", () => {
      // clientHeight = 100px -> available = 68px -> pageSize = 4
      const { rail, messagesEl } = setupTurnRailFixture({ clientHeight: 100 });
      rail.switchTab("tab-1");

      for (let i = 0; i < 6; i++) {
        const msg = messagesEl.createDiv({ cls: "hermesian-message is-user" });
        rail.registerUserMessage("tab-1", msg, `Turn ${i}`);
      }

      const pagination = rail.getPagination("tab-1");
      expect(pagination).toBeDefined();
      expect(pagination!.endIndex).toBe(6);
      expect(pagination!.startIndex).toBe(2); // shows turns 2..5 (4 dots)

      const dots = rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot");
      expect(dots.length).toBe(4);
      expect(dots[0].getAttribute("data-turn-index")).toBe("2");
      expect(dots[3].getAttribute("data-turn-index")).toBe("5");

      // Older turns exist (0, 1) -> up arrow is visible
      expect(rail.prevBtn.classList.contains("is-hidden")).toBe(false);
    });

    it("pages up to earlier turns on up arrow click, and hides up arrow at oldest page", () => {
      // pageSize = 4
      const { rail, messagesEl } = setupTurnRailFixture({ clientHeight: 100 });
      rail.switchTab("tab-1");

      for (let i = 0; i < 6; i++) {
        const msg = messagesEl.createDiv({ cls: "hermesian-message is-user" });
        rail.registerUserMessage("tab-1", msg, `Turn ${i}`);
      }

      // First page shows turns 2..5. Click up arrow.
      rail.prevBtn.click();

      const pagination = rail.getPagination("tab-1");
      expect(pagination!.endIndex).toBe(2);
      expect(pagination!.startIndex).toBe(0); // now at oldest page [0..1]

      const dots = rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot");
      expect(dots.length).toBe(2);
      expect(dots[0].getAttribute("data-turn-index")).toBe("0");
      expect(dots[1].getAttribute("data-turn-index")).toBe("1");

      // At oldest page -> up arrow disappears
      expect(rail.prevBtn.classList.contains("is-hidden")).toBe(true);
    });
  });

  describe("Click dot to jump & pause auto-follow", () => {
    it("scrolls user message to top and pauses auto-follow when scrolled away from bottom", () => {
      const { rail, messagesEl, scrollFollow } = setupTurnRailFixture({
        clientHeight: 200,
        thresholdPx: 40,
      });
      rail.switchTab("tab-1");

      // Set scrollHeight large enough so scrolling to turn 0 is far from bottom
      Object.defineProperty(messagesEl, "scrollHeight", { value: 2000, configurable: true });

      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      Object.defineProperty(msg1, "offsetTop", { value: 120, configurable: true });
      rail.registerUserMessage("tab-1", msg1, "First turn");

      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      Object.defineProperty(msg2, "offsetTop", { value: 800, configurable: true });
      rail.registerUserMessage("tab-1", msg2, "Second turn");

      const dots = rail.trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");
      expect(dots.length).toBe(2);

      // Follow initially active
      expect(scrollFollow.isFollowing("tab-1")).toBe(true);

      // Click first dot
      dots[0].click();

      // Scrolled to turn 1 top
      expect(messagesEl.scrollTop).toBe(120);

      // Distance from bottom is 2000 - 200 - 120 = 1680 > 40px threshold -> Follow locked!
      expect(scrollFollow.isLocked("tab-1")).toBe(true);
      expect(scrollFollow.isFollowing("tab-1")).toBe(false);
    });
  });

  describe("Highlighting current turn on scroll", () => {
    it("updates .is-current dot according to messagesEl.scrollTop", () => {
      const { rail, messagesEl } = setupTurnRailFixture({ clientHeight: 200 });
      rail.switchTab("tab-1");

      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      Object.defineProperty(msg1, "offsetTop", { value: 0, configurable: true });
      rail.registerUserMessage("tab-1", msg1, "Turn 0");

      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      Object.defineProperty(msg2, "offsetTop", { value: 300, configurable: true });
      rail.registerUserMessage("tab-1", msg2, "Turn 1");

      const msg3 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      Object.defineProperty(msg3, "offsetTop", { value: 700, configurable: true });
      rail.registerUserMessage("tab-1", msg3, "Turn 2");

      const dots = rail.trackEl.querySelectorAll<HTMLButtonElement>(".hermesian-turn-rail-dot");

      // Initially at top (scrollTop = 0) -> Turn 0 is current
      expect(dots[0].classList.contains("is-current")).toBe(true);
      expect(dots[1].classList.contains("is-current")).toBe(false);
      expect(dots[2].classList.contains("is-current")).toBe(false);

      // Scroll to turn 1
      messagesEl.scrollTop = 350;
      rail.updateScrollPosition();

      expect(dots[0].classList.contains("is-current")).toBe(false);
      expect(dots[1].classList.contains("is-current")).toBe(true);
      expect(dots[2].classList.contains("is-current")).toBe(false);

      // Scroll to turn 2
      messagesEl.scrollTop = 750;
      rail.updateScrollPosition();

      expect(dots[0].classList.contains("is-current")).toBe(false);
      expect(dots[1].classList.contains("is-current")).toBe(false);
      expect(dots[2].classList.contains("is-current")).toBe(true);
    });
  });

  describe("Back to Bottom floating button", () => {
    it("appears only when follow is locked AND away from bottom", () => {
      const { rail, messagesEl, scrollFollow } = setupTurnRailFixture({
        clientHeight: 200,
        thresholdPx: 40,
      });
      rail.switchTab("tab-1");
      Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });

      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg1, "Turn 1");
      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-1", msg2, "Turn 2");

      // Case 1: Unlocked, at bottom -> Hidden
      messagesEl.scrollTop = 800; // at bottom
      rail.updateScrollPosition();
      expect(rail.backToBottomEl.classList.contains("is-hidden")).toBe(true);

      // Case 2: Unlocked, away from bottom -> Hidden (follow not locked yet)
      messagesEl.scrollTop = 200;
      rail.updateScrollPosition();
      expect(rail.backToBottomEl.classList.contains("is-hidden")).toBe(true);

      // Case 3: Locked, away from bottom -> Shown!
      scrollFollow.lock("tab-1");
      rail.updateScrollPosition();
      expect(rail.backToBottomEl.classList.contains("is-hidden")).toBe(false);

      // Case 4: Locked, but scrolled back near bottom -> Hidden
      messagesEl.scrollTop = 780; // dist = 20 <= 40
      rail.updateScrollPosition();
      expect(rail.backToBottomEl.classList.contains("is-hidden")).toBe(true);
    });

    it("resets pagination, scrolls to bottom, unlocks follow, and hides on click", () => {
      const { rail, messagesEl, scrollFollow, onScrollToBottom } = setupTurnRailFixture({
        clientHeight: 100, // small page size = 4
        thresholdPx: 40,
      });
      rail.switchTab("tab-1");
      Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });

      for (let i = 0; i < 6; i++) {
        const msg = messagesEl.createDiv({ cls: "hermesian-message is-user" });
        rail.registerUserMessage("tab-1", msg, `Turn ${i}`);
      }

      // User paged up to older turns
      rail.prevBtn.click();
      expect(rail.getPagination("tab-1")!.startIndex).toBe(0);

      // Lock and move away from bottom
      scrollFollow.lock("tab-1");
      messagesEl.scrollTop = 100;
      rail.updateScrollPosition();
      expect(rail.backToBottomEl.classList.contains("is-hidden")).toBe(false);

      // Click Back to Bottom
      rail.backToBottomEl.click();

      // Triggered callback
      expect(onScrollToBottom).toHaveBeenCalledWith("tab-1");
      // Follow unlocked
      expect(scrollFollow.isFollowing("tab-1")).toBe(true);
      // Pagination reset to latest page
      expect(rail.getPagination("tab-1")!.endIndex).toBe(6);
      // Back to bottom button hides
      expect(rail.backToBottomEl.classList.contains("is-hidden")).toBe(true);
    });
  });

  describe("Multi-Tab switching", () => {
    it("switches rail contents and preserves pagination independently per tab", () => {
      const { rail, messagesEl } = setupTurnRailFixture({ clientHeight: 100 });

      // Tab A has 3 turns
      rail.switchTab("tab-A");
      for (let i = 0; i < 3; i++) {
        const msg = messagesEl.createDiv({ cls: "hermesian-message is-user" });
        rail.registerUserMessage("tab-A", msg, `A-${i}`);
      }
      expect(rail.railEl.classList.contains("is-hidden")).toBe(false);
      expect(rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot").length).toBe(3);

      // Tab B has only 1 turn
      rail.switchTab("tab-B");
      const msgB = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-B", msgB, "B-0");
      // Tab B hidden (< 2 turns)
      expect(rail.railEl.classList.contains("is-hidden")).toBe(true);

      // Switch back to Tab A -> restored!
      rail.switchTab("tab-A");
      expect(rail.railEl.classList.contains("is-hidden")).toBe(false);
      expect(rail.trackEl.querySelectorAll(".hermesian-turn-rail-dot").length).toBe(3);
    });

    it("cleans up tab data on forget", () => {
      const { rail, messagesEl } = setupTurnRailFixture();
      rail.switchTab("tab-X");
      const msg1 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-X", msg1, "X-0");
      const msg2 = messagesEl.createDiv({ cls: "hermesian-message is-user" });
      rail.registerUserMessage("tab-X", msg2, "X-1");

      expect(rail.getTurns("tab-X").length).toBe(2);

      rail.forget("tab-X");
      expect(rail.getTurns("tab-X").length).toBe(0);
      expect(rail.railEl.classList.contains("is-hidden")).toBe(true);
    });
  });
});
