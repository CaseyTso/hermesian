import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
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
  Notice: vi.fn(),
  setIcon: vi.fn((el: HTMLElement, iconId: string) => {
    el.setAttribute("data-icon", iconId);
    el.innerHTML = `<svg data-icon="${iconId}"></svg>`;
  }),
}));

import {
  extractMermaidBlocks,
  replaceMermaidPlaceholders,
  type MermaidBlock,
} from "../src/markdown-mermaid";

describe("markdown-mermaid", () => {
  describe("extractMermaidBlocks", () => {
    it("returns unmodified text when no mermaid blocks exist", () => {
      const text = "Hello world\n\nThis is plain text with no diagram.";
      const { processedText, mermaidBlocks } = extractMermaidBlocks(text);

      expect(processedText).toBe(text);
      expect(mermaidBlocks).toEqual([]);
    });

    it("extracts a single standard mermaid code block", () => {
      const source = "graph TD\n  A[Start] --> B[End]";
      const markdown = `Before diagram\n\`\`\`mermaid\n${source}\n\`\`\`\nAfter diagram`;
      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0]).toEqual({
        index: 0,
        source,
        placeholder: "<!--HERMESIAN-MERMAID-0-->",
      });
      expect(processedText).toBe(
        "Before diagram\n<!--HERMESIAN-MERMAID-0-->\nAfter diagram",
      );
    });

    it("extracts multiple mermaid code blocks with sequential indices", () => {
      const source1 = "graph LR\n  A --> B";
      const source2 = "pie title Pets\n  \"Dogs\": 10\n  \"Cats\": 5";
      const markdown = `Diagram 1:\n\`\`\`mermaid\n${source1}\n\`\`\`\nMiddle text\n\`\`\`mermaid\n${source2}\n\`\`\`\nEnd text`;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(2);
      expect(mermaidBlocks[0]).toEqual({
        index: 0,
        source: source1,
        placeholder: "<!--HERMESIAN-MERMAID-0-->",
      });
      expect(mermaidBlocks[1]).toEqual({
        index: 1,
        source: source2,
        placeholder: "<!--HERMESIAN-MERMAID-1-->",
      });
      expect(processedText).toBe(
        "Diagram 1:\n<!--HERMESIAN-MERMAID-0-->\nMiddle text\n<!--HERMESIAN-MERMAID-1-->\nEnd text",
      );
    });

    it("extracts mermaid block fenced with tildes ~~~", () => {
      const source = "sequenceDiagram\n  Alice->>Bob: Hi";
      const markdown = `~~~mermaid\n${source}\n~~~`;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe(source);
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });

    it("extracts mermaid block fenced with 4 or more backticks", () => {
      const source = "graph TD\n  A --> B";
      const markdown = `\`\`\`\`mermaid\n${source}\n\`\`\`\``;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe(source);
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });

    it("extracts mermaid block with info string / title attributes", () => {
      const source = "graph TD\n  A --> B";
      const markdown = `\`\`\`mermaid title="System Overview" class="center"\n${source}\n\`\`\``;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe(source);
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });

    it("extracts case-insensitive Mermaid tags", () => {
      const source = "graph TD\n  A --> B";
      const markdown = `\`\`\`Mermaid\n${source}\n\`\`\``;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe(source);
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });

    it("extracts empty mermaid code block", () => {
      const markdown = "```mermaid\n```";

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe("");
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });

    it("ignores non-mermaid code blocks", () => {
      const markdown = `\`\`\`typescript\nconst x = 1;\n\`\`\`\n\n\`\`\`python\nprint("hello")\n\`\`\`\n\n\`\`\`\nplain code\n\`\`\``;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toEqual([]);
      expect(processedText).toBe(markdown);
    });

    it("ignores inline text mentioning mermaid", () => {
      const markdown = "You can use `mermaid` or `mermaid.js` for charts.";

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toEqual([]);
      expect(processedText).toBe(markdown);
    });

    it("ignores hyphenated language tags like mermaid-js", () => {
      const markdown = "```mermaid-js\nconst x = 1;\n```";

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toEqual([]);
      expect(processedText).toBe(markdown);
    });

    it("handles indented code blocks and strips leading indentation from content", () => {
      const markdown = "   ```mermaid\n   graph TD\n     A --> B\n   ```";

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe("graph TD\n  A --> B");
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });

    it("handles Windows CRLF line endings", () => {
      const markdown = "Intro\r\n```mermaid\r\ngraph TD\r\n  A --> B\r\n```\r\nOutro";

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe("graph TD\r\n  A --> B");
      expect(processedText).toBe("Intro\r\n<!--HERMESIAN-MERMAID-0-->\r\nOutro");
    });

    it("handles Mermaid labels containing backticks", () => {
      const source = "graph TD\n  A[\"`Markdown with `code` backtick`\"] --> B";
      const markdown = `\`\`\`mermaid\n${source}\n\`\`\``;

      const { processedText, mermaidBlocks } = extractMermaidBlocks(markdown);

      expect(mermaidBlocks).toHaveLength(1);
      expect(mermaidBlocks[0].source).toBe(source);
      expect(processedText).toBe("<!--HERMESIAN-MERMAID-0-->");
    });
  });

  describe("replaceMermaidPlaceholders", () => {
    let container: HTMLElement;
    let window: Window;

    beforeEach(() => {
      window = new Window();
      vi.stubGlobal("window", window);
      vi.stubGlobal("document", window.document);
      vi.stubGlobal("HTMLElement", window.HTMLElement);
      vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);

      container = window.document.createElement("div") as any;
      (window.document.body as any).appendChild(container);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    it("does nothing when blocks array is empty", () => {
      container.innerHTML = "<p>Plain text</p>";

      replaceMermaidPlaceholders(container, []);

      expect(container.innerHTML).toBe("<p>Plain text</p>");
    });

    it("replaces Comment node at container root with DiagramSurface", () => {
      container.innerHTML = "<p>Before</p><!--HERMESIAN-MERMAID-0--><p>After</p>";

      const blocks: MermaidBlock[] = [
        {
          index: 0,
          source: "graph TD\n  A --> B",
          placeholder: "<!--HERMESIAN-MERMAID-0-->",
        },
      ];

      replaceMermaidPlaceholders(container, blocks);

      expect(container.querySelector(".hermesian-mermaid-container")).not.toBeNull();
      const surface = container.querySelector(".hermesian-diagram-surface");
      expect(surface).not.toBeNull();
      expect(surface?.querySelector("svg")).not.toBeNull();
      expect(surface?.querySelector(".hermesian-diagram-toolbar")).not.toBeNull();
      expect(container.innerHTML).not.toContain("HERMESIAN-MERMAID-0");
    });

    it("replaces Comment node inside paragraph, unwrapping the empty paragraph", () => {
      container.innerHTML = "<p>Paragraph 1</p><p><!--HERMESIAN-MERMAID-0--></p><p>Paragraph 2</p>";

      const blocks: MermaidBlock[] = [
        {
          index: 0,
          source: "graph TD\n  A --> B",
          placeholder: "<!--HERMESIAN-MERMAID-0-->",
        },
      ];

      replaceMermaidPlaceholders(container, blocks);

      // The middle <p> should have been replaced by the .hermesian-mermaid-container <div>
      expect(container.children).toHaveLength(3);
      expect(container.children[0].tagName).toBe("P");
      expect(container.children[0].textContent).toBe("Paragraph 1");
      expect(container.children[1].tagName).toBe("DIV");
      expect(container.children[1].className).toBe("hermesian-mermaid-container");
      expect(container.children[2].tagName).toBe("P");
      expect(container.children[2].textContent).toBe("Paragraph 2");
    });

    it("replaces Text node when markdown renderer emitted text containing placeholder", () => {
      container.textContent = "Before\n<!--HERMESIAN-MERMAID-0-->\nAfter";

      const blocks: MermaidBlock[] = [
        {
          index: 0,
          source: "graph TD\n  A --> B",
          placeholder: "<!--HERMESIAN-MERMAID-0-->",
        },
      ];

      replaceMermaidPlaceholders(container, blocks);

      expect(container.querySelector(".hermesian-mermaid-container")).not.toBeNull();
      expect(container.textContent).toContain("Before");
      expect(container.textContent).toContain("After");
      expect(container.textContent).not.toContain("<!--HERMESIAN-MERMAID-0-->");
    });

    it("replaces multiple placeholders in correct order", () => {
      container.innerHTML =
        "<p>P1</p><p><!--HERMESIAN-MERMAID-0--></p><p>P2</p><p><!--HERMESIAN-MERMAID-1--></p><p>P3</p>";

      const blocks: MermaidBlock[] = [
        {
          index: 0,
          source: "graph TD\n  A --> B",
          placeholder: "<!--HERMESIAN-MERMAID-0-->",
        },
        {
          index: 1,
          source: "pie title Pets\n  \"Dogs\": 10",
          placeholder: "<!--HERMESIAN-MERMAID-1-->",
        },
      ];

      replaceMermaidPlaceholders(container, blocks);

      const diagrams = container.querySelectorAll(".hermesian-diagram-surface");
      expect(diagrams).toHaveLength(2);
      expect(diagrams[0].getAttribute("data-diagram-type")).toBe("flowchart");
      expect(diagrams[1].getAttribute("data-diagram-type")).toBe("pie");

      expect(container.children).toHaveLength(5);
      expect(container.children[1].classList.contains("hermesian-mermaid-container")).toBe(true);
      expect(container.children[3].classList.contains("hermesian-mermaid-container")).toBe(true);
    });

    it("renders invalid mermaid code into error state with toggleable source", () => {
      container.innerHTML = "<p><!--HERMESIAN-MERMAID-0--></p>";

      const blocks: MermaidBlock[] = [
        {
          index: 0,
          source: "invalid mermaid syntax ???",
          placeholder: "<!--HERMESIAN-MERMAID-0-->",
        },
      ];

      replaceMermaidPlaceholders(container, blocks);

      const surface = container.querySelector(".hermesian-diagram-surface");
      expect(surface).not.toBeNull();
      expect(surface?.classList.contains("is-error")).toBe(true);
      expect(surface?.querySelector(".hermesian-diagram-error")).not.toBeNull();
      expect(surface?.querySelector(".hermesian-diagram-toggle-source")).not.toBeNull();
    });

    it("falls back to appending when placeholder node is missing in DOM", () => {
      container.innerHTML = "<p>Some text where placeholder was stripped</p>";

      const blocks: MermaidBlock[] = [
        {
          index: 0,
          source: "graph TD\n  A --> B",
          placeholder: "<!--HERMESIAN-MERMAID-0-->",
        },
      ];

      replaceMermaidPlaceholders(container, blocks);

      const surface = container.querySelector(".hermesian-diagram-surface");
      expect(surface).not.toBeNull();
      expect(container.children[container.children.length - 1].classList.contains("hermesian-mermaid-container")).toBe(true);
    });
  });
});
