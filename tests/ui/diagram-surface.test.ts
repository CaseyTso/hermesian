import { readFileSync } from "node:fs";
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
  DiagramSurface,
  getDiagramCategory,
  parseDiagramTypeFromSvg,
  renderDiagramSurface,
  SIMPLE_DIAGRAM_TYPES,
  WIDE_DIAGRAM_TYPES,
} from "../../src/ui/diagram-surface";

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("DiagramSurface", () => {
  let container: HTMLElement;

  beforeEach(() => {
    const window = new Window();
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

  describe("Diagram category classification", () => {
    it("classifies simple diagram types correctly", () => {
      const simpleTypes = [
        "flowchart",
        "pie",
        "mindmap",
        "journey",
        "timeline",
        "gitGraph",
      ];
      for (const type of simpleTypes) {
        expect(SIMPLE_DIAGRAM_TYPES.has(type)).toBe(true);
        expect(getDiagramCategory(type)).toBe("simple");
      }
    });

    it("classifies wide diagram types correctly", () => {
      const wideTypes = ["sequence", "class", "state", "er", "gantt"];
      for (const type of wideTypes) {
        expect(WIDE_DIAGRAM_TYPES.has(type)).toBe(true);
        expect(getDiagramCategory(type)).toBe("wide");
      }
    });

    it("defaults unknown types to simple", () => {
      expect(getDiagramCategory("unknown-type")).toBe("simple");
    });
  });

  describe("parseDiagramTypeFromSvg", () => {
    it("extracts type from pele class name", () => {
      const svg = '<svg class="pele pele-flowchart" viewBox="0 0 100 100"></svg>';
      expect(parseDiagramTypeFromSvg(svg)).toBe("flowchart");
    });

    it("extracts type from aria-roledescription fallback", () => {
      const svg = '<svg class="custom-class" aria-roledescription="sequence"></svg>';
      expect(parseDiagramTypeFromSvg(svg)).toBe("sequence");
    });

    it("returns undefined when no recognizable type is present", () => {
      const svg = '<svg class="generic"></svg>';
      expect(parseDiagramTypeFromSvg(svg)).toBeUndefined();
    });
  });

  describe("Rendering simple diagram types", () => {
    it("renders flowchart with fit-width scaling strategy", () => {
      const source = "graph TD\n  A[Start] --> B[Finish]";
      const surface = renderDiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("flowchart");
      expect(surface.category).toBe("simple");
      expect(surface.rootEl.classList.contains("is-simple")).toBe(true);
      expect(surface.rootEl.dataset.diagramCategory).toBe("simple");
      expect(surface.rootEl.dataset.diagramType).toBe("flowchart");

      expect(surface.viewportEl).not.toBeNull();
      const svg = surface.viewportEl?.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.style.width).toBe("100%");
      expect(svg?.style.maxWidth).toBe("100%");
      expect(svg?.style.height).toBe("auto");
      expect(surface.viewportEl?.style.overflowX).toBe("hidden");
    });

    it("renders pie chart as simple category", () => {
      const source = 'pie title Pets\n"Dogs" : 386\n"Cats" : 85';
      const surface = new DiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("pie");
      expect(surface.category).toBe("simple");
      expect(surface.rootEl.classList.contains("is-simple")).toBe(true);
    });

    it("renders mindmap as simple category", () => {
      const source = "mindmap\n  root((Root))\n    Leaf";
      const surface = new DiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("mindmap");
      expect(surface.category).toBe("simple");
    });
  });

  describe("Rendering complex / wide diagram types", () => {
    it("renders sequence diagram with horizontal scroll strategy", () => {
      const source = "sequenceDiagram\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice";
      const surface = renderDiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("sequence");
      expect(surface.category).toBe("wide");
      expect(surface.rootEl.classList.contains("is-wide")).toBe(true);
      expect(surface.rootEl.dataset.diagramCategory).toBe("wide");
      expect(surface.rootEl.dataset.diagramType).toBe("sequence");

      expect(surface.viewportEl).not.toBeNull();
      const svg = surface.viewportEl?.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.style.maxWidth).toBe("none");
      expect(svg?.style.flexShrink).toBe("0");
      expect(surface.viewportEl?.style.overflowX).toBe("auto");
    });

    it("renders class diagram as wide category", () => {
      const source = "classDiagram\n  class Animal\n  Animal : +name string";
      const surface = new DiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("class");
      expect(surface.category).toBe("wide");
      expect(surface.rootEl.classList.contains("is-wide")).toBe(true);
    });

    it("renders er diagram as wide category", () => {
      const source = "erDiagram\n  CUSTOMER ||--o{ ORDER : places";
      const surface = new DiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("er");
      expect(surface.category).toBe("wide");
      expect(surface.rootEl.classList.contains("is-wide")).toBe(true);
    });

    it("renders gantt chart as wide category", () => {
      const source = "gantt\n  title Project\n  section S\n  Task: 2024-01-01, 2d";
      const surface = new DiagramSurface({
        container,
        source,
      });

      expect(surface.isError).toBe(false);
      expect(surface.type).toBe("gantt");
      expect(surface.category).toBe("wide");
      expect(surface.rootEl.classList.contains("is-wide")).toBe(true);
    });
  });

  describe("Error handling", () => {
    it("handles invalid mermaid syntax without throwing", () => {
      const invalidSource = "invalid mermaid code not a diagram";
      const surface = renderDiagramSurface({
        container,
        source: invalidSource,
      });

      expect(surface.isError).toBe(true);
      expect(surface.rootEl.classList.contains("is-error")).toBe(true);
      expect(surface.viewportEl).toBeNull();
      expect(surface.errorEl).not.toBeNull();

      const errorText = surface.errorEl?.querySelector(".hermesian-diagram-error-text");
      expect(errorText?.textContent).toBe("图表语法有误，无法渲染");

      const icon = surface.errorEl?.querySelector(".hermesian-diagram-error-icon");
      expect(icon?.getAttribute("data-icon")).toBe("alert-triangle");

      // Verify toggle button and collapsible source
      expect(surface.toggleSourceButtonEl).not.toBeNull();
      expect(surface.toggleSourceButtonEl?.textContent).toBe("查看源码");
      expect(surface.sourceEl).not.toBeNull();
      expect(surface.sourceEl?.style.display).toBe("none");

      // Click to expand source
      surface.toggleSourceButtonEl?.click();
      expect(surface.sourceEl?.style.display).toBe("block");
      expect(surface.toggleSourceButtonEl?.textContent).toBe("收起源码");
      expect(surface.toggleSourceButtonEl?.getAttribute("aria-expanded")).toBe("true");

      const codeEl = surface.sourceEl?.querySelector("code");
      expect(codeEl?.textContent).toBe(invalidSource);

      // Click again to collapse
      surface.toggleSourceButtonEl?.click();
      expect(surface.sourceEl?.style.display).toBe("none");
      expect(surface.toggleSourceButtonEl?.textContent).toBe("查看源码");
      expect(surface.toggleSourceButtonEl?.getAttribute("aria-expanded")).toBe("false");
    });

    it("disables expand and export buttons in error state but keeps copy enabled", () => {
      const surface = renderDiagramSurface({
        container,
        source: "bad syntax",
      });

      expect(surface.expandButtonEl.disabled).toBe(true);
      expect(surface.exportButtonEl.disabled).toBe(true);
      expect(surface.copyButtonEl.disabled).toBe(false);
    });
  });

  describe("Action buttons and callbacks", () => {
    it("wires expand, exportPng, and copySource callbacks in normal state", async () => {
      const onExpand = vi.fn();
      const onExportPng = vi.fn();
      const onCopySource = vi.fn();
      const clipboardWrite = vi.fn().mockResolvedValue(undefined);

      const surface = renderDiagramSurface({
        container,
        source: "graph TD\n  A --> B",
        onExpand,
        onExportPng,
        onCopySource,
        clipboard: { writeText: clipboardWrite },
      });

      expect(surface.expandButtonEl.disabled).toBe(false);
      expect(surface.exportButtonEl.disabled).toBe(false);
      expect(surface.copyButtonEl.disabled).toBe(false);

      // Click expand
      surface.expandButtonEl.click();
      expect(onExpand).toHaveBeenCalledTimes(1);

      // Click export PNG
      surface.exportButtonEl.click();
      expect(onExportPng).toHaveBeenCalledTimes(1);

      // Click copy source
      surface.copyButtonEl.click();
      await tick();
      expect(onCopySource).toHaveBeenCalledTimes(1);
      expect(clipboardWrite).toHaveBeenCalledWith("graph TD\n  A --> B");

      // Check copied feedback
      expect(surface.copyButtonEl.classList.contains("is-copied")).toBe(true);
      expect(surface.copyButtonEl.getAttribute("data-icon")).toBe("check");
    });

    it("copies source using default clipboard when onCopySource is omitted", async () => {
      const clipboardWrite = vi.fn().mockResolvedValue(undefined);

      const surface = renderDiagramSurface({
        container,
        source: "graph LR\n  X --> Y",
        clipboard: { writeText: clipboardWrite },
      });

      surface.copyButtonEl.click();
      await tick();
      expect(clipboardWrite).toHaveBeenCalledWith("graph LR\n  X --> Y");
      expect(surface.copyButtonEl.classList.contains("is-copied")).toBe(true);
    });

    it("reverts copied state after timeout", async () => {
      vi.useFakeTimers();
      const clipboardWrite = vi.fn().mockResolvedValue(undefined);

      const surface = renderDiagramSurface({
        container,
        source: "graph LR\n  A --> B",
        clipboard: { writeText: clipboardWrite },
      });

      surface.copyButtonEl.click();
      await tick();
      expect(surface.copyButtonEl.classList.contains("is-copied")).toBe(true);
      expect(surface.copyButtonEl.getAttribute("data-icon")).toBe("check");

      vi.advanceTimersByTime(2000);
      expect(surface.copyButtonEl.classList.contains("is-copied")).toBe(false);
      expect(surface.copyButtonEl.getAttribute("data-icon")).toBe("copy");

      vi.useRealTimers();
    });

    it("cleans up timer and removes element on destroy", () => {
      vi.useFakeTimers();
      const surface = renderDiagramSurface({
        container,
        source: "graph LR\n  A --> B",
        clipboard: { writeText: vi.fn() },
      });

      surface.copyButtonEl.click();
      expect(container.contains(surface.rootEl)).toBe(true);

      surface.destroy();
      expect(container.contains(surface.rootEl)).toBe(false);

      vi.advanceTimersByTime(3000); // Should not throw
      vi.useRealTimers();
    });
  });

  describe("styles.css diagram surface rules", () => {
    const styles = readFileSync(
      new URL("../../styles.css", import.meta.url),
      "utf8",
    );

    it("contains required diagram surface class selectors", () => {
      expect(styles).toContain(".hermesian-diagram-surface");
      expect(styles).toContain(".hermesian-diagram-viewport");
      expect(styles).toContain(".hermesian-diagram-toolbar");
      expect(styles).toContain(".hermesian-diagram-button");
      expect(styles).toContain(".hermesian-diagram-error");
      expect(styles).toContain(".hermesian-diagram-source");
      expect(styles).toContain(".hermesian-diagram-toggle-source");
    });

    it("configures pele CSS variables for theme adaptivity", () => {
      expect(styles).toContain("--pele-bg:");
      expect(styles).toContain("--pele-fg:");
      expect(styles).toContain("--pele-muted:");
      expect(styles).toContain("--pele-line:");
      expect(styles).toContain("--pele-surface:");
      expect(styles).toContain("--pele-border:");
      expect(styles).toContain("--pele-accent:");
    });

    it("configures dark theme overrides for pele variables", () => {
      expect(styles).toContain(".theme-dark .hermesian-diagram-surface");
    });

    it("configures smart scaling CSS rules for simple and wide categories", () => {
      expect(styles).toContain(".hermesian-diagram-surface.is-simple");
      expect(styles).toContain(".hermesian-diagram-surface.is-wide");
      expect(styles).toContain("overflow-x: auto;");
    });

    it("contains diagram modal styles", () => {
      expect(styles).toContain(".hermesian-diagram-modal");
      expect(styles).toContain(".hermesian-diagram-modal-zoom-bar");
      expect(styles).toContain(".hermesian-diagram-modal-viewport");
      expect(styles).toContain(".hermesian-diagram-modal-toolbar");
    });
  });

  describe("Diagram Surface integration with DiagramModal & PNG export", () => {
    it("opens DiagramModal when expand button is clicked with app provided", () => {
      const mockApp = {
        fileManager: { getAvailablePathForAttachment: vi.fn() },
        vault: { adapter: {} },
      } as any;

      const surface = renderDiagramSurface({
        app: mockApp,
        container,
        source: "graph TD\n  A --> B",
      });

      expect(surface.svgContent).not.toBeNull();
      const openModalSpy = vi.spyOn(surface, "openModal");
      surface.expandButtonEl.click();

      expect(openModalSpy).toHaveBeenCalledTimes(1);
    });

    it("triggers PNG export flow when export button is clicked with app provided", async () => {
      const fileSaverMock = vi.fn(async () => "/exported/diagram.png");
      const pngExporterMock = vi.fn(
        async () => new Blob(["png"], { type: "image/png" }),
      );
      const mockApp = {
        fileManager: { getAvailablePathForAttachment: vi.fn() },
        vault: { adapter: {} },
      } as any;

      const surface = renderDiagramSurface({
        app: mockApp,
        container,
        source: "graph TD\n  A --> B",
        pngExporter: pngExporterMock,
        fileSaver: fileSaverMock,
      });

      surface.exportButtonEl.click();
      await tick();

      expect(pngExporterMock).toHaveBeenCalledTimes(1);
      expect(fileSaverMock).toHaveBeenCalledTimes(1);
    });
  });
});
