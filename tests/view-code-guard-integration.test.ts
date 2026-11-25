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
      renderLikeObsidianWithDataview(markdown, el);
    }),
  },
  Notice: vi.fn(),
  setIcon: vi.fn((el: HTMLElement, iconId: string) => {
    el.setAttribute("data-icon", iconId);
    el.innerHTML = `<svg data-icon="${iconId}"></svg>`;
  }),
}));

import { HermesianSidebarView } from "../src/view";

/**
 * A stand-in for Obsidian's reading renderer with Dataview installed, limited
 * to what these tests need: paragraphs, inline code, fenced blocks, raw HTML.
 * Like Dataview, it turns any code starting with `=` into an error block,
 * runs code starting with `$=` as JavaScript, and runs `dataview` /
 * `dataviewjs` blocks as queries.
 */
function renderLikeObsidianWithDataview(markdown: string, el: HTMLElement): void {
  const doc = el.ownerDocument;
  // Inline code keeps its text escaped, like a real renderer; other raw HTML passes through.
  const inline = (text: string) =>
    text.replace(
      /`([^`\n]+)`|([^`]+|`)/g,
      (_match, code: string | undefined, rest: string | undefined) =>
        code !== undefined
          ? `<code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`
          : (rest ?? ""),
    );
  const dataviewInline = (section: HTMLElement) => {
    for (const code of Array.from(section.querySelectorAll("code"))) {
      const text = (code.textContent ?? "").trim();
      if (text.startsWith("$=")) {
        const executed = doc.createElement("span");
        executed.className = "dataview-executed";
        executed.textContent = "EXECUTED";
        code.replaceWith(executed);
      } else if (text.startsWith("=")) {
        const error = doc.createElement("pre");
        error.className = "dataview dataview-error";
        error.textContent = `Dataview (inline field '${text.slice(1)}'): PARSING FAILED`;
        section.appendChild(error);
      }
    }
  };
  const section = (node: Node) => {
    const wrapper = doc.createElement("div");
    wrapper.appendChild(node);
    el.appendChild(wrapper);
    dataviewInline(wrapper);
  };

  const lines = markdown.split("\n");
  let paragraph: string[] = [];
  let fence: { language: string; body: string[] } | undefined;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const p = doc.createElement("p");
      p.innerHTML = inline(paragraph.join("\n"));
      section(p);
      paragraph = [];
    }
  };

  for (const line of lines) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/);
    if (fence) {
      if (/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) {
        if (fence.language === "dataview" || fence.language === "dataviewjs") {
          const result = doc.createElement("div");
          result.className = "dataview-result";
          result.textContent = "EXECUTED";
          section(result);
        } else {
          const pre = doc.createElement("pre");
          const code = doc.createElement("code");
          code.textContent = fence.body.join("\n");
          pre.appendChild(code);
          section(pre);
        }
        fence = undefined;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    if (opening) {
      flushParagraph();
      fence = { language: opening[2].toLowerCase(), body: [] };
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") {
      flushParagraph();
    } else if (/^<!--.*-->$/.test(trimmed)) {
      flushParagraph();
      section(doc.createComment(trimmed.slice(4, -3)));
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
}

function codeTexts(root: HTMLElement): Array<string | null> {
  return Array.from(root.querySelectorAll("code"), (code) => code.textContent);
}

describe("HermesianSidebarView code guard against note post-processors", () => {
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

  it("shows the highlight syntax that Dataview misread as code, with no error block", async () => {
    // The assistant message shape that produced the reported
    // "Dataview (inline field '=...=='): PARSING FAILED".
    const text = "| 环节 | 提取文中的 `<mark>...</mark>` 与 `==...==` 高亮词。 |";

    await view.renderMarkdown(targetEl, text);

    expect(targetEl.querySelector(".dataview-error")).toBeNull();
    expect(codeTexts(targetEl)).toEqual(["<mark>...</mark>", "==...=="]);
    expect(targetEl.textContent).not.toContain("`");
    expect(targetEl.textContent).not.toContain("hermesian-code");
  });

  it("shows $= code instead of letting Dataview run it", async () => {
    await view.renderMarkdown(targetEl, '写法：`$= dv.page("Today").file.name`');

    expect(targetEl.querySelector(".dataview-executed")).toBeNull();
    expect(codeTexts(targetEl)).toEqual(['$= dv.page("Today").file.name']);
  });

  it("shows a dataviewjs block instead of letting Dataview run it", async () => {
    const text = '示例：\n\n```dataviewjs\ndv.list(dv.pages("books"))\n```';

    await view.renderMarkdown(targetEl, text);

    expect(targetEl.querySelector(".dataview-result")).toBeNull();
    expect(renderCalls[0]).not.toContain("dataviewjs");
    expect(codeTexts(targetEl)).toEqual(['dv.list(dv.pages("books"))\n']);
    expect(targetEl.querySelector("pre")?.className).toBe("language-dataviewjs");
  });

  it("hands code no post-processor would run to Obsidian untouched", async () => {
    const text = "比较 `a == b` 与 `>=`：\n\n```python\nresult = a == b\n```";

    await view.renderMarkdown(targetEl, text);

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toBe(text);
    expect(codeTexts(targetEl)).toEqual(["a == b", ">=", "result = a == b"]);
    expect(targetEl.querySelector(".dataview-error")).toBeNull();
  });

  it("guards the message when an active turn is finalized", async () => {
    targetEl.classList.add("is-streaming");
    view.turnManager = {
      ensure: vi.fn(() => ({
        assistantContentEl: targetEl,
        assistantText: "已将选区替换为：`==a highlighted phrase==`。",
      })),
    };
    view.scrollToBottom = vi.fn();

    await view.finalizeAssistantMessage("tab-1");

    expect(targetEl.classList.contains("is-streaming")).toBe(false);
    expect(targetEl.querySelector(".dataview-error")).toBeNull();
    expect(codeTexts(targetEl)).toEqual(["==a highlighted phrase=="]);
  });

  it("guards code and renders a diagram in the same message", async () => {
    const text = "高亮写法 `==x==`：\n\n```mermaid\ngraph TD\n  A --> B\n```";

    await view.renderMarkdown(targetEl, text);

    expect(targetEl.querySelector(".hermesian-diagram-surface")).not.toBeNull();
    expect(targetEl.querySelector(".dataview-error")).toBeNull();
    expect(codeTexts(targetEl)).toEqual(["==x=="]);
    expect(targetEl.textContent).toContain("高亮写法");
  });
});
