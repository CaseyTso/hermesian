import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stylesCss = readFileSync(
  new URL("../../styles.css", import.meta.url),
  "utf8",
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Mock obsidian module
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
      document.body.appendChild(this.modalEl);
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
      // Basic mock render for tables
      if (markdown.includes("|")) {
        el.innerHTML = `
          <table>
            <thead>
              <tr><th>Header 1</th><th>Header 2</th></tr>
            </thead>
            <tbody>
              <tr><td>Cell 1</td><td>Cell 2</td></tr>
            </tbody>
          </table>
        `;
      } else {
        el.innerHTML = `<p>${markdown}</p>`;
      }
    }),
  },
  Notice: vi.fn(),
  setIcon: vi.fn((el: HTMLElement, iconId: string) => {
    el.setAttribute("data-icon", iconId);
    el.innerHTML = `<svg data-icon="${iconId}"></svg>`;
  }),
}));

import {
  TableModal,
  handleRenderedLinkClick,
} from "../../src/ui/table-modal";
import { HermesianSidebarView } from "../../src/view";

describe("TableModal component", () => {
  let window: Window;
  let mockApp: any;
  let sampleTable: HTMLTableElement;

  beforeEach(() => {
    window = new Window();
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("Node", window.Node);
    vi.stubGlobal("Text", window.Text);
    vi.stubGlobal("Element", window.Element);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);
    vi.stubGlobal("HTMLAnchorElement", window.HTMLAnchorElement);
    vi.stubGlobal("HTMLTableElement", window.HTMLTableElement);
    vi.stubGlobal("MouseEvent", window.MouseEvent);

    // Provide Obsidian Element prototype helper
    (HTMLElement.prototype as any).hasClass = function (cls: string) {
      return this.classList.contains(cls);
    };

    mockApp = {
      workspace: {
        openLinkText: vi.fn(async () => {}),
      },
    };

    sampleTable = document.createElement("table");
    sampleTable.innerHTML = `
      <thead>
        <tr><th>Col A</th><th>Col B</th></tr>
      </thead>
      <tbody>
        <tr><td>Data 1</td><td>Data 2</td></tr>
      </tbody>
    `;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("clones the source table so original table is not mutated or moved", () => {
    const modal = new TableModal(mockApp, sampleTable);
    expect(modal.tableEl).not.toBe(sampleTable);
    expect(modal.tableEl.innerHTML).toBe(sampleTable.innerHTML);
  });

  it("initializes modal with correct title, class, viewport, and close button", () => {
    const modal = new TableModal(mockApp, sampleTable);
    modal.onOpen();

    expect(modal.titleEl.textContent).toBe("表格查看");
    expect(modal.modalEl.classList.contains("hermesian-table-modal")).toBe(true);

    // Viewport contains cloned table
    expect(modal.viewportEl).not.toBeNull();
    expect(modal.viewportEl?.classList.contains("hermesian-table-modal-viewport")).toBe(true);
    expect(modal.viewportEl?.contains(modal.tableEl)).toBe(true);

    // Close button exists in footer and calls close()
    expect(modal.closeBtnEl).not.toBeNull();
    expect(modal.closeBtnEl?.textContent).toBe("关闭");

    const closeSpy = vi.spyOn(modal, "close");
    modal.closeBtnEl?.click();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("cleans up content and listeners on close", () => {
    const modal = new TableModal(mockApp, sampleTable);
    modal.onOpen();
    expect(modal.viewportEl).not.toBeNull();

    modal.close();
    expect(modal.viewportEl).toBeNull();
    expect(modal.closeBtnEl).toBeNull();
    expect(modal.contentEl.innerHTML).toBe("");
  });

  describe("link handling in modal", () => {
    it("delegates internal links to app.workspace.openLinkText", () => {
      const tableWithLinks = document.createElement("table");
      tableWithLinks.innerHTML = `
        <tbody>
          <tr>
            <td>
              <a class="internal-link" data-href="TargetNote" href="TargetNote">TargetNote</a>
            </td>
          </tr>
        </tbody>
      `;

      const modal = new TableModal(mockApp, tableWithLinks, {
        sourcePath: "folder/current.md",
      });
      modal.onOpen();

      const internalLink = modal.tableEl.querySelector<HTMLAnchorElement>("a.internal-link")!;
      expect(internalLink).not.toBeNull();

      const clickEvent = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event;
      internalLink.dispatchEvent(clickEvent);

      expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith(
        "TargetNote",
        "folder/current.md",
        false,
      );
    });

    it("passes newLeaf=true when meta or ctrl key is pressed on internal link", () => {
      const tableWithLinks = document.createElement("table");
      tableWithLinks.innerHTML = `
        <tbody>
          <tr>
            <td>
              <a class="internal-link" data-href="OtherNote" href="OtherNote">OtherNote</a>
            </td>
          </tr>
        </tbody>
      `;

      const modal = new TableModal(mockApp, tableWithLinks, {
        sourcePath: "current.md",
      });
      modal.onOpen();

      const internalLink = modal.tableEl.querySelector<HTMLAnchorElement>("a.internal-link")!;
      const clickEvent = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }) as unknown as Event;
      internalLink.dispatchEvent(clickEvent);

      expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith(
        "OtherNote",
        "current.md",
        true,
      );
    });

    it("opens external http/https links using window.open", () => {
      const windowOpenMock = vi.fn();
      vi.stubGlobal("open", windowOpenMock);
      window.open = windowOpenMock;

      const tableWithExternalLink = document.createElement("table");
      tableWithExternalLink.innerHTML = `
        <tbody>
          <tr>
            <td>
              <a href="https://example.com/docs">External Docs</a>
            </td>
          </tr>
        </tbody>
      `;

      const modal = new TableModal(mockApp, tableWithExternalLink);
      modal.onOpen();

      const externalLink = modal.tableEl.querySelector<HTMLAnchorElement>("a")!;
      const clickEvent = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event;
      externalLink.dispatchEvent(clickEvent);

      expect(windowOpenMock).toHaveBeenCalledWith(
        "https://example.com/docs",
        "_blank",
        "noopener,noreferrer",
      );
    });

    it("does not open non-http external links (e.g. javascript:)", () => {
      const windowOpenMock = vi.fn();
      vi.stubGlobal("open", windowOpenMock);
      window.open = windowOpenMock;

      const tableWithBadLink = document.createElement("table");
      tableWithBadLink.innerHTML = `
        <tbody>
          <tr>
            <td>
              <a href="javascript:alert(1)">Bad Link</a>
            </td>
          </tr>
        </tbody>
      `;

      const modal = new TableModal(mockApp, tableWithBadLink);
      modal.onOpen();

      const link = modal.tableEl.querySelector<HTMLAnchorElement>("a")!;
      const clickEvent = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event;
      link.dispatchEvent(clickEvent);

      expect(windowOpenMock).not.toHaveBeenCalled();
    });

    it("ignores clicks on non-link table cells", () => {
      const windowOpenMock = vi.fn();
      vi.stubGlobal("open", windowOpenMock);
      window.open = windowOpenMock;

      const modal = new TableModal(mockApp, sampleTable);
      modal.onOpen();

      const cell = modal.tableEl.querySelector("td")!;
      cell.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
      );

      expect(mockApp.workspace.openLinkText).not.toHaveBeenCalled();
      expect(windowOpenMock).not.toHaveBeenCalled();
    });

    it("honors onLinkClick custom override if provided", () => {
      const customLinkHandler = vi.fn();
      const tableWithLinks = document.createElement("table");
      tableWithLinks.innerHTML = `
        <tbody>
          <tr>
            <td><a href="https://example.com">Link</a></td>
          </tr>
        </tbody>
      `;

      const modal = new TableModal(mockApp, tableWithLinks, {
        onLinkClick: customLinkHandler,
      });
      modal.onOpen();

      const link = modal.tableEl.querySelector("a")!;
      link.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
      );

      expect(customLinkHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleRenderedLinkClick standalone function", () => {
    it("returns false if event target is not an anchor", () => {
      const div = document.createElement("div");
      const event = new window.MouseEvent("click", {
        bubbles: true,
      }) as unknown as MouseEvent;
      Object.defineProperty(event, "target", { value: div });
      expect(handleRenderedLinkClick(event, mockApp)).toBe(false);
    });

    it("returns false if anchor has no href", () => {
      const anchor = document.createElement("a");
      const event = new window.MouseEvent("click", {
        bubbles: true,
      }) as unknown as MouseEvent;
      Object.defineProperty(event, "target", { value: anchor });
      expect(handleRenderedLinkClick(event, mockApp)).toBe(false);
    });

    it("handles internal links and extracts sourcePath from data-source-path attribute", () => {
      const container = document.createElement("div");
      container.dataset.sourcePath = "notes/my-source.md";
      const anchor = document.createElement("a");
      anchor.className = "internal-link";
      anchor.setAttribute("href", "TargetPage");
      container.appendChild(anchor);

      const event = new window.MouseEvent("click", {
        bubbles: true,
      }) as unknown as MouseEvent;
      Object.defineProperty(event, "target", { value: anchor });

      const handled = handleRenderedLinkClick(event, mockApp, "fallback.md");
      expect(handled).toBe(true);
      expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith(
        "TargetPage",
        "notes/my-source.md",
        false,
      );
    });

    it("handles external links with window.open", () => {
      const windowOpenMock = vi.fn();
      vi.stubGlobal("open", windowOpenMock);
      window.open = windowOpenMock;

      const anchor = document.createElement("a");
      anchor.setAttribute("href", "https://obsidian.md/download");

      const event = new window.MouseEvent("click", {
        bubbles: true,
      }) as unknown as MouseEvent;
      Object.defineProperty(event, "target", { value: anchor });

      const handled = handleRenderedLinkClick(event, mockApp);
      expect(handled).toBe(true);
      expect(windowOpenMock).toHaveBeenCalledWith(
        "https://obsidian.md/download",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });
});

describe("styles.css table rules and sticky freezing", () => {
  const css = stripComments(stylesCss);

  it("defines .hermesian-table-frame with position: relative and max-width: 100%", () => {
    expect(css).toMatch(/\.hermesian-table-frame\s*\{[^}]*position:\s*relative;/);
    expect(css).toMatch(/\.hermesian-table-frame\s*\{[^}]*max-width:\s*100%;/);
  });

  it("defines .hermesian-table-expand-button at top-left corner", () => {
    expect(css).toMatch(/\.hermesian-table-expand-button\s*\{[^}]*position:\s*absolute;/);
    expect(css).toMatch(/\.hermesian-table-expand-button\s*\{[^}]*top:\s*6px;/);
    expect(css).toMatch(/\.hermesian-table-expand-button\s*\{[^}]*left:\s*6px;/);
    expect(css).toMatch(/\.hermesian-table-expand-button\s*\{[^}]*z-index:\s*5;/);
    // Button is not positioned at right corner
    expect(css).not.toMatch(/\.hermesian-table-expand-button\s*\{[^}]*right:\s*6px;/);
  });

  it("defines .hermesian-table-modal dimensions matching DiagramModal convention", () => {
    expect(css).toMatch(/--modal-width:\s*960px;/);
    expect(css).toMatch(/--modal-max-width:\s*92vw;/);
    expect(css).toMatch(/--modal-height:\s*85vh;/);
    expect(css).toMatch(/--modal-max-height:\s*85vh;/);
  });

  it("defines bidirectional scrolling on .hermesian-table-modal-viewport", () => {
    expect(css).toMatch(/\.hermesian-table-modal-viewport\s*\{[^}]*overflow:\s*auto;/);
  });

  it("freezes table header row with position: sticky, top: 0, and z-index: 2 in modal", () => {
    expect(css).toMatch(
      /\.hermesian-table-modal-viewport\s+thead\s+th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*2;/,
    );
  });

  it("freezes first column with position: sticky, left: 0, and z-index: 1 in modal", () => {
    expect(css).toMatch(
      /\.hermesian-table-modal-viewport\s+tbody\s+tr\s*>\s*:first-child,\s*\.hermesian-table-modal-viewport\s+thead\s+tr\s*>\s*:first-child\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0;[^}]*z-index:\s*1;/,
    );
  });

  it("gives the top-left intersecting cell sticky top+left and highest z-index: 3 in modal", () => {
    expect(css).toMatch(
      /\.hermesian-table-modal-viewport\s+thead\s+tr\s*>\s*:first-child\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*z-index:\s*3;/,
    );
  });

  it("ensures frozen cells have opaque backgrounds (not transparent)", () => {
    // Header row background
    expect(css).toMatch(
      /\.hermesian-table-modal-viewport\s+thead\s+th\s*\{[^}]*background:\s*var\(--background-secondary-alt\);/,
    );
    // First column background
    expect(css).toMatch(
      /\.hermesian-table-modal-viewport\s+tbody\s+tr\s*>\s*:first-child,\s*\.hermesian-table-modal-viewport\s+thead\s+tr\s*>\s*:first-child\s*\{[^}]*background:\s*var\(--background-primary\);/,
    );
    // Top-left cell background
    expect(css).toMatch(
      /\.hermesian-table-modal-viewport\s+thead\s+tr\s*>\s*:first-child\s*\{[^}]*background:\s*var\(--background-secondary-alt\);/,
    );
  });

  it("does NOT freeze sidebar small tables (sticky freeze is strictly modal-only)", () => {
    // The sidebar assistant table rule must not contain position: sticky
    const sidebarAssistantTableRule = css.match(
      /\.hermesian-message\.is-assistant\s+\.hermesian-message-content\s+:is\([^)]*\)\s*\{([^}]*)\}/,
    );
    expect(sidebarAssistantTableRule).not.toBeNull();
    expect(sidebarAssistantTableRule![1]).not.toContain("position: sticky");
    expect(sidebarAssistantTableRule![1]).not.toContain("sticky");
  });
});

describe("HermesianSidebarView assistant table enhancement integration", () => {
  let window: Window;
  let view: any;
  let targetEl: HTMLElement;
  let app: any;

  beforeEach(() => {
    window = new Window();
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("Node", window.Node);
    vi.stubGlobal("Text", window.Text);
    vi.stubGlobal("Element", window.Element);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);
    vi.stubGlobal("HTMLAnchorElement", window.HTMLAnchorElement);
    vi.stubGlobal("HTMLTableElement", window.HTMLTableElement);
    vi.stubGlobal("MouseEvent", window.MouseEvent);

    (HTMLElement.prototype as any).empty = function () {
      this.innerHTML = "";
    };
    (HTMLElement.prototype as any).removeClass = function (cls: string) {
      this.classList.remove(cls);
    };
    (HTMLElement.prototype as any).hasClass = function (cls: string) {
      return this.classList.contains(cls);
    };
    (HTMLElement.prototype as any).createDiv = function (options: any = {}) {
      const el = document.createElement("div");
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

    app = {
      workspace: {
        openLinkText: vi.fn(),
      },
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

  it("wraps assistant message table in .hermesian-table-frame with expand button", async () => {
    const message = document.createElement("div");
    message.className = "hermesian-message is-assistant";
    targetEl = document.createElement("div");
    targetEl.className = "hermesian-message-content";
    message.appendChild(targetEl);

    const markdownWithTable = "| Col A | Col B |\n|---|---|\n| 1 | 2 |";
    await view.renderMarkdown(targetEl, markdownWithTable);

    const frame = targetEl.querySelector(".hermesian-table-frame");
    expect(frame).not.toBeNull();

    const expandBtn = frame?.querySelector<HTMLButtonElement>(".hermesian-table-expand-button");
    expect(expandBtn).not.toBeNull();
    expect(expandBtn?.getAttribute("aria-label")).toBe("展开看全表");
    expect(expandBtn?.getAttribute("title")).toBe("展开看全表");
    expect(expandBtn?.getAttribute("data-icon")).toBe("maximize-2");

    const table = frame?.querySelector("table");
    expect(table).not.toBeNull();
  });

  it("clicking expand button opens TableModal with cloned table", async () => {
    const message = document.createElement("div");
    message.className = "hermesian-message is-assistant";
    targetEl = document.createElement("div");
    targetEl.className = "hermesian-message-content";
    message.appendChild(targetEl);

    const markdownWithTable = "| Header |\n|---|\n| Cell |";
    await view.renderMarkdown(targetEl, markdownWithTable);

    const expandBtn = targetEl.querySelector<HTMLButtonElement>(".hermesian-table-expand-button")!;
    expect(expandBtn).not.toBeNull();

    expandBtn.click();

    // Verify modal was opened
    const modalEl = document.querySelector(".hermesian-table-modal");
    expect(modalEl).not.toBeNull();
    expect(modalEl?.querySelector(".modal-title")?.textContent).toBe("表格查看");

    // Modal contains the table
    const modalTable = modalEl?.querySelector(".hermesian-table-modal-viewport table");
    expect(modalTable).not.toBeNull();
  });

  it("does NOT add expand button or table frame to user messages", async () => {
    const userMessage = document.createElement("div");
    userMessage.className = "hermesian-message is-user";
    targetEl = document.createElement("div");
    targetEl.className = "hermesian-message-content";
    userMessage.appendChild(targetEl);

    const markdownWithTable = "| User Header |\n|---|\n| User Cell |";
    await view.renderMarkdown(targetEl, markdownWithTable);

    expect(targetEl.querySelector(".hermesian-table-frame")).toBeNull();
    expect(targetEl.querySelector(".hermesian-table-expand-button")).toBeNull();
    // Raw table still exists
    expect(targetEl.querySelector("table")).not.toBeNull();
  });
});
