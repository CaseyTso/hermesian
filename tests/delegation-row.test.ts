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
import { MessageRenderer, TurnManager } from "../src/ui/message-renderer";
import type { HermesHistoryItem, HermesUiEvent } from "../src/types";

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

function setupTestEnvironment() {
  const parent = document.createElement("div");
  const messagesEl = parent.createDiv({ cls: "hermesian-messages" });
  const renderer = new MessageRenderer(messagesEl as HTMLElement);
  renderer.show("tab-1");
  const turnCallbacks = { onTurnComplete: vi.fn() };
  const turns = new TurnManager(renderer, turnCallbacks);

  const view = Object.create(HermesianSidebarView.prototype) as any;
  view.turnManager = turns;
  view.messageRenderer = renderer;
  view.scrollToBottom = vi.fn();
  view.renderMarkdown = vi.fn(async (el: HTMLElement, md: string) => {
    el.textContent = md;
  });
  view.attachMessageCopyButton = vi.fn();
  view.messageContainer = () => renderer.containerFor("tab-1");

  return { parent, messagesEl, renderer, turns, view };
}

describe("Delegation Row - styles.css visual contract", () => {
  it("defines .hermesian-delegation with card styling and theme variables", () => {
    const block = getBlock(".hermesian-delegation");
    expect(block).toMatch(/background:\s*var\(--background-secondary\);/);
    expect(block).toMatch(/border:\s*1px solid var\(--hermesian-border\);/);
    expect(block).toMatch(/border-radius:\s*var\(--hermesian-radius-card\);/);
    expect(block).toMatch(/font-size:\s*var\(--font-ui-smaller\);/);
  });

  it("styles .hermesian-delegation > summary as interactive flex row with cursor pointer", () => {
    const block = getBlock(".hermesian-delegation > summary");
    expect(block).toMatch(/display:\s*flex;/);
    expect(block).toMatch(/align-items:\s*center;/);
    expect(block).toMatch(/cursor:\s*pointer;/);
    expect(block).toMatch(/user-select:\s*none;/);
  });

  it("styles .hermesian-delegation pre for scrolling and monospace display", () => {
    const block = getBlock(".hermesian-delegation pre");
    expect(block).toMatch(/font-family:\s*var\(--font-monospace\);/);
    expect(block).toMatch(/white-space:\s*pre-wrap;/);
    expect(block).toMatch(/overflow:\s*auto;/);
  });

  it("contains no hardcoded colors in delegation row styles", () => {
    const start = stylesCss.indexOf(".hermesian-delegation {");
    const end = stylesCss.indexOf(".hermesian-permission {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const rules = stripComments(stylesCss.slice(start, end));
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});

describe("Delegation Row - Component behavior", () => {
  beforeEach(() => {
    const window = new Window();
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);

    (HTMLElement.prototype as any).createDiv = function (options: any = {}) {
      const el = document.createElement("div");
      if (options.cls) el.className = options.cls;
      if (options.text !== undefined) el.textContent = String(options.text);
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Scenario 1: Real-time render as expandable row while in_progress / pending
  it("renders delegate_task as an open details element with summary and task list", () => {
    const { view } = setupTestEnvironment();

    const startEvent: Extract<HermesUiEvent, { type: "tool" }> = {
      type: "tool",
      id: "del_1",
      title: "delegate_task: 2 subtasks",
      kind: "execute",
      status: "in_progress",
      content: "Delegating 2 tasks:\n1. Inspect files\n2. Implement fix",
    };

    view.renderToolEvent("tab-1", startEvent);

    const runtime = view.turnRuntime("tab-1");
    const el = runtime.toolEls.get("del_1") as HTMLDetailsElement;
    expect(el).toBeDefined();

    // Must be a <details> element with .hermesian-delegation
    expect(el.tagName).toBe("DETAILS");
    expect(el.classList.contains("hermesian-delegation")).toBe(true);

    // In-progress: must be open (expanded)
    expect(el.open).toBe(true);

    // Summary row checks: title + status
    const summary = el.querySelector("summary");
    expect(summary).not.toBeNull();

    const titleEl = summary!.querySelector(".hermesian-tool-title");
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent).toBe("delegate_task: 2 subtasks");

    const statusEl = summary!.querySelector(".hermesian-tool-status");
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).toBe("in_progress");

    // Content pre check: initial task list
    const pre = el.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("Delegating 2 tasks:\n1. Inspect files\n2. Implement fix");
  });

  // Scenario 2: Collapse on completion/failure and remain expandable manually
  it("automatically collapses when status becomes completed, keeping full results expandable", () => {
    const { view } = setupTestEnvironment();

    // Start event
    view.renderToolEvent("tab-1", {
      type: "tool",
      id: "del_2",
      title: "delegate_task: batch jobs",
      kind: "execute",
      status: "in_progress",
      content: "Delegating 1 task:\n1. Build assets",
    });

    const runtime = view.turnRuntime("tab-1");
    let el = runtime.toolEls.get("del_2") as HTMLDetailsElement;
    expect(el.open).toBe(true);

    // Completion event
    const completedContent =
      "Delegating 1 task:\n1. Build assets\n\nDelegation results: 1 task in 3s\n✅ Task 1: completed";
    view.renderToolEvent("tab-1", {
      type: "tool",
      id: "del_2",
      title: "delegate_task: batch jobs",
      kind: "execute",
      status: "completed",
      content: completedContent,
    });

    el = runtime.toolEls.get("del_2") as HTMLDetailsElement;

    // Completed: must automatically collapse (open = false)
    expect(el.open).toBe(false);

    // Status updated
    const statusEl = el.querySelector("summary .hermesian-tool-status");
    expect(statusEl?.textContent).toBe("completed");

    // Pre contains full accumulated results
    const pre = el.querySelector("pre");
    expect(pre?.textContent).toBe(completedContent);

    // Manually expandable: user can toggle open and view content
    el.open = true;
    expect(el.open).toBe(true);
    expect(el.querySelector("pre")?.textContent).toBe(completedContent);
  });

  it("automatically collapses on failure while preserving error summary in pre", () => {
    const { view } = setupTestEnvironment();

    view.renderToolEvent("tab-1", {
      type: "tool",
      id: "del_fail",
      title: "delegate_task: subtask",
      kind: "execute",
      status: "in_progress",
      content: "Delegating task:\n1. Run risky script",
    });

    view.renderToolEvent("tab-1", {
      type: "tool",
      id: "del_fail",
      title: "delegate_task: subtask",
      kind: "execute",
      status: "failed",
      content: "Delegating task:\n1. Run risky script\n\nDelegation failed: timed out",
    });

    const runtime = view.turnRuntime("tab-1");
    const el = runtime.toolEls.get("del_fail") as HTMLDetailsElement;

    expect(el.open).toBe(false);
    expect(el.querySelector("summary .hermesian-tool-status")?.textContent).toBe("failed");
    expect(el.querySelector("pre")?.textContent).toContain("Delegation failed: timed out");
  });

  // Scenario 3: History replay cannot expand (renders as ordinary non-expandable tool row)
  it("renders delegation tool in history replay as an ordinary non-expandable row", async () => {
    const { view, messagesEl } = setupTestEnvironment();

    const historyItems: HermesHistoryItem[] = [
      {
        id: "hist_del",
        kind: "tool",
        title: "delegate_task: 2 subtasks",
        status: "completed",
      },
    ];

    await view.renderHistoryTurn(historyItems, "tab-1");

    const toolEl = messagesEl.querySelector(".hermesian-turn .hermesian-tool");
    expect(toolEl).not.toBeNull();

    // Must be a DIV, NOT DETAILS
    expect(toolEl!.tagName).toBe("DIV");
    expect(toolEl!.classList.contains("hermesian-delegation")).toBe(false);

    // Must not have summary or pre (not expandable)
    expect(toolEl!.querySelector("summary")).toBeNull();
    expect(toolEl!.querySelector("pre")).toBeNull();

    // Still displays title and status
    expect(toolEl!.querySelector(".hermesian-tool-title")?.textContent).toBe(
      "delegate_task: 2 subtasks",
    );
    expect(toolEl!.querySelector(".hermesian-tool-status")?.textContent).toBe(
      "completed",
    );
  });

  // Scenario 4: Non-delegation tools unaffected
  it("keeps non-delegation tools (process, read_file, edit) as normal non-expandable divs", () => {
    const { view } = setupTestEnvironment();

    // Process tool
    view.renderToolEvent("tab-1", {
      type: "tool",
      id: "proc_1",
      title: "process: list",
      kind: "execute",
      status: "in_progress",
    });

    const runtime = view.turnRuntime("tab-1");
    const procEl = runtime.toolEls.get("proc_1")!;
    expect(procEl.tagName).toBe("DIV");
    expect(procEl.classList.contains("hermesian-tool")).toBe(true);
    expect(procEl.classList.contains("hermesian-delegation")).toBe(false);
    expect(procEl.querySelector("summary")).toBeNull();
    expect(procEl.querySelector("pre")).toBeNull();
    expect(procEl.querySelector(".hermesian-tool-title")?.textContent).toBe("process: list");
    expect(procEl.querySelector(".hermesian-tool-status")?.textContent).toBe("in_progress");

    // Edit tool
    view.renderToolEvent("tab-1", {
      type: "tool",
      id: "edit_1",
      title: "patch: src/main.ts",
      kind: "edit",
      status: "completed",
    });

    const editEl = runtime.toolEls.get("edit_1")!;
    expect(editEl.tagName).toBe("DIV");
    expect(editEl.classList.contains("hermesian-tool")).toBe(true);
    expect(editEl.querySelector(".hermesian-tool-title")?.textContent).toBe("patch: src/main.ts");
    expect(editEl.querySelector(".hermesian-tool-status")?.textContent).toBe("completed");
  });
});
