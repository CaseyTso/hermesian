import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderCalls: string[] = [];

vi.mock("obsidian", () => ({
  ItemView: class {
    app: any;
    containerEl = document.createElement("div");
    constructor(leaf: any) {
      this.app = leaf.app;
    }
  },
  Modal: class {
    app: any;
    modalEl: HTMLElement;
    titleEl: HTMLElement;
    contentEl: HTMLElement;
    constructor(app: any) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.modalEl.className = "modal";
      this.titleEl = document.createElement("div");
      this.titleEl.className = "modal-title";
      this.contentEl = document.createElement("div");
      this.contentEl.className = "modal-content";
      this.modalEl.appendChild(this.titleEl);
      this.modalEl.appendChild(this.contentEl);
    }
    setTitle(title: string) {
      this.titleEl.textContent = title;
      return this;
    }
    open() {
      this.onOpen();
    }
    close() {
      this.onClose();
      this.modalEl.remove();
    }
    onOpen() {}
    onClose() {}
  },
  SuggestModal: class {},
  MarkdownView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: {
    render: vi.fn(async (_app: any, markdown: string, el: HTMLElement) => {
      renderCalls.push(markdown);
      // Realistic CommonMark HTML block mock
      el.innerHTML = markdown
        .split("\n\n")
        .map((block) => `<p>${block}</p>`)
        .join("");
    }),
  },
  Notice: vi.fn(),
  setIcon: vi.fn((el: HTMLElement, iconId: string) => {
    el.setAttribute("data-icon", iconId);
    el.innerHTML = `<svg data-icon="${iconId}"></svg>`;
  }),
}));

import { HermesianSidebarView } from "../src/view";

describe("HermesianSidebarView Mermaid Diagram Integration", () => {
  let view: any;
  let targetEl: HTMLElement;
  let window: Window;

  beforeEach(() => {
    renderCalls.length = 0;
    window = new Window();
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);
    vi.stubGlobal("Text", window.Text);
    vi.stubGlobal("Node", window.Node);

    targetEl = window.document.createElement("div") as any;
    (window.document.body as any).appendChild(targetEl);

    (HTMLElement.prototype as any).empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
    (HTMLElement.prototype as any).removeClass = function (cls: string) {
      this.classList.remove(cls);
    };
    (HTMLElement.prototype as any).addClass = function (cls: string) {
      this.classList.add(cls);
    };
    (HTMLElement.prototype as any).hasClass = function (cls: string) {
      return this.classList.contains(cls);
    };

    const app = {
      workspace: { layoutReady: true, onLayoutReady: vi.fn() },
      vault: {},
    };
    const plugin = {
      attachView: vi.fn(),
      getConversationControllerDependencies: vi.fn(),
      setConversationWorkspace: vi.fn(),
      getCurrentDocumentContext: vi.fn(),
      getCurrentMarkdownFilePath: vi.fn(),
      peekClient: vi.fn(),
      getClient: vi.fn(),
      getReasoningEffort: vi.fn(() => "off"),
    };

    view = new HermesianSidebarView({ app } as any, plugin as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("intercepts mermaid code block and replaces it with DiagramSurface", async () => {
    const text = "Here is the diagram:\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n\nEnjoy!";

    await view.renderMarkdown(targetEl, text);

    // 1. MarkdownRenderer should have been called with placeholder, NOT raw mermaid code
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toContain("<!--HERMESIAN-MERMAID-0-->");
    expect(renderCalls[0]).not.toContain("```mermaid");
    expect(renderCalls[0]).not.toContain("graph TD");

    // 2. targetEl should contain DiagramSurface component
    const surfaceEl = targetEl.querySelector(".hermesian-diagram-surface");
    expect(surfaceEl).not.toBeNull();
    expect(surfaceEl?.classList.contains("is-simple")).toBe(true);
    expect(surfaceEl?.getAttribute("data-diagram-type")).toBe("flowchart");

    // 3. SVG should be rendered by pele inside the viewport
    const svgEl = surfaceEl?.querySelector("svg");
    expect(svgEl).not.toBeNull();

    // 4. Action toolbar should be present
    const toolbar = surfaceEl?.querySelector(".hermesian-diagram-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('button[aria-label="放大"]')).not.toBeNull();
    expect(toolbar?.querySelector('button[aria-label="导出 PNG"]')).not.toBeNull();
    expect(toolbar?.querySelector('button[aria-label="复制源码"]')).not.toBeNull();

    // 5. Surrounding markdown text should still be present
    expect(targetEl.textContent).toContain("Here is the diagram:");
    expect(targetEl.textContent).toContain("Enjoy!");
  });

  it("does not affect non-mermaid code blocks", async () => {
    const text = "Here is some code:\n\n```typescript\nconst x: number = 42;\n```";

    await view.renderMarkdown(targetEl, text);

    // MarkdownRenderer should receive the untouched code block
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toContain("```typescript");
    expect(renderCalls[0]).toContain("const x: number = 42;");

    // No DiagramSurface should be mounted
    expect(targetEl.querySelector(".hermesian-diagram-surface")).toBeNull();
  });

  it("removes is-streaming class when rendering", async () => {
    targetEl.classList.add("is-streaming");

    const text = "```mermaid\ngraph TD\n  A --> B\n```";
    await view.renderMarkdown(targetEl, text);

    expect(targetEl.classList.contains("is-streaming")).toBe(false);
  });

  it("renders multiple mermaid blocks in the same message", async () => {
    const text =
      "First diagram:\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nSecond diagram:\n\n```mermaid\npie title Pets\n  \"Dogs\": 10\n  \"Cats\": 5\n```";

    await view.renderMarkdown(targetEl, text);

    const surfaces = targetEl.querySelectorAll(".hermesian-diagram-surface");
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].getAttribute("data-diagram-type")).toBe("flowchart");
    expect(surfaces[1].getAttribute("data-diagram-type")).toBe("pie");
  });

  it("renders invalid mermaid block with error fallback UI", async () => {
    const text = "```mermaid\ninvalid mermaid syntax !!!\n```";

    await view.renderMarkdown(targetEl, text);

    const surfaceEl = targetEl.querySelector(".hermesian-diagram-surface");
    expect(surfaceEl).not.toBeNull();
    expect(surfaceEl?.classList.contains("is-error")).toBe(true);

    const errorEl = surfaceEl?.querySelector(".hermesian-diagram-error");
    expect(errorEl).not.toBeNull();

    const toggleBtn = surfaceEl?.querySelector(".hermesian-diagram-toggle-source");
    expect(toggleBtn).not.toBeNull();
  });

  it("renders DiagramSurface when finalizing assistant message", async () => {
    targetEl.classList.add("is-streaming");
    view.turnManager = {
      ensure: vi.fn(() => ({
        assistantContentEl: targetEl,
        assistantText: "Result:\n\n```mermaid\ngraph LR\n  X --> Y\n```",
      })),
    };
    view.scrollToBottom = vi.fn();

    await view.finalizeAssistantMessage("tab-1");

    expect(targetEl.classList.contains("is-streaming")).toBe(false);
    const surfaceEl = targetEl.querySelector(".hermesian-diagram-surface");
    expect(surfaceEl).not.toBeNull();
    expect(surfaceEl?.getAttribute("data-diagram-type")).toBe("flowchart");
    expect(targetEl.textContent).toContain("Result:");
  });

  it("renders DiagramSurface in historical session assistant turn", async () => {
    const historyContainer = window.document.createElement("div");
    (HTMLElement.prototype as any).createDiv = function (options?: any) {
      const el = window.document.createElement("div");
      if (options?.cls) el.className = options.cls;
      this.appendChild(el);
      return el;
    };
    (HTMLElement.prototype as any).createEl = function (tag: string, options?: any) {
      const el = window.document.createElement(tag);
      if (options?.cls) el.className = options.cls;
      if (options?.text) el.textContent = options.text;
      this.appendChild(el);
      return el;
    };
    (HTMLElement.prototype as any).createSpan = function (options?: any) {
      const el = window.document.createElement("span");
      if (options?.cls) el.className = options.cls;
      if (options?.text) el.textContent = options.text;
      this.appendChild(el);
      return el;
    };

    view.messageRenderer = {
      containerFor: () => historyContainer,
    };
    view.attachMessageCopyButton = vi.fn();

    await view.renderHistoryTurn(
      [
        {
          kind: "assistant",
          text: "Here is your flow:\n\n```mermaid\ngraph TD\n  Start --> Done\n```",
        },
      ],
      "tab-1",
    );

    const message = historyContainer.querySelector(".hermesian-message.is-assistant");
    expect(message).not.toBeNull();

    const surface = historyContainer.querySelector(".hermesian-diagram-surface");
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("data-diagram-type")).toBe("flowchart");
    expect(historyContainer.textContent).toContain("Here is your flow:");
  });
});
