import { type App, Notice, setIcon } from "obsidian";
import { render } from "pele";
import {
  DiagramModal,
  copyTextToClipboard,
  savePngToFile,
  svgToPngBlob,
} from "./diagram-modal";

/**
 * Diagram types that scale to fit the container width while preserving aspect ratio.
 */
export const SIMPLE_DIAGRAM_TYPES: ReadonlySet<string> = new Set([
  "flowchart",
  "pie",
  "mindmap",
  "journey",
  "timeline",
  "gitGraph",
]);

/**
 * Inherently wide or complex diagram types that preserve their original dimensions
 * with horizontal scrolling in narrow sidebar containers.
 */
export const WIDE_DIAGRAM_TYPES: ReadonlySet<string> = new Set([
  "sequence",
  "class",
  "state",
  "er",
  "gantt",
]);

export type DiagramCategory = "simple" | "wide";

/**
 * Resolves the diagram sizing category.
 * Simple diagrams fit container width; wide diagrams preserve original size with horizontal scroll.
 */
export function getDiagramCategory(type: string): DiagramCategory {
  if (WIDE_DIAGRAM_TYPES.has(type)) {
    return "wide";
  }
  if (SIMPLE_DIAGRAM_TYPES.has(type)) {
    return "simple";
  }
  return "simple";
}

/**
 * Parses the diagram type from the rendered SVG string (class name or aria-roledescription).
 */
export function parseDiagramTypeFromSvg(svg: string): string | undefined {
  const classMatch = svg.match(/\bpele-([a-zA-Z0-9_-]+)\b/);
  if (classMatch && classMatch[1] !== "pele") {
    return classMatch[1];
  }
  const roleMatch = svg.match(/aria-roledescription="([^"]+)"/);
  if (roleMatch) {
    return roleMatch[1];
  }
  return undefined;
}

export interface DiagramSurfaceOptions {
  /** Obsidian App 实例（用于打开 Modal、文件保存等） */
  app?: App;
  /** 容器元素，SVG 将被挂载到其中 */
  container: HTMLElement;
  /** 原始 mermaid 源码 */
  source: string;
  /** 点击放大回调（若提供则优先调用；未提供且传入了 app 则打开 DiagramModal） */
  onExpand?: () => void;
  /** 导出 PNG 回调（若提供则优先调用；未提供且传入了 app 则执行保存到文件） */
  onExportPng?: () => void;
  /** 复制源码回调 */
  onCopySource?: () => void;
  /** 可选剪贴板接口（用于测试或宿主环境自定义） */
  clipboard?: { writeText(text: string): Promise<void> };
  /** 可选图标渲染器（默认使用 Obsidian setIcon） */
  iconRenderer?: (element: HTMLElement, iconId: string) => void;
  /** 可选 PNG 导出处理函数（用于测试或自定义） */
  pngExporter?: (svgContent: string) => Promise<Blob>;
  /** 可选文件保存函数（用于测试或自定义） */
  fileSaver?: (blob: Blob) => Promise<string | null>;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  className?: string,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const el = parent.ownerDocument.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
  }
  parent.appendChild(el);
  return el;
}


/**
 * Diagram Surface component.
 * Renders Mermaid diagrams synchronously via pele into a theme-adaptive SVG container
 * with smart sizing (fit-width vs overflow-x) and actions to expand, export PNG, and copy source.
 */
export class DiagramSurface {
  readonly options: DiagramSurfaceOptions;
  readonly rootEl: HTMLElement;
  readonly viewportEl: HTMLElement | null = null;
  readonly toolbarEl: HTMLElement;
  readonly expandButtonEl: HTMLButtonElement;
  readonly exportButtonEl: HTMLButtonElement;
  readonly copyButtonEl: HTMLButtonElement;
  readonly errorEl: HTMLElement | null = null;
  readonly sourceEl: HTMLElement | null = null;
  readonly toggleSourceButtonEl: HTMLButtonElement | null = null;
  readonly type: string | undefined;
  readonly category: DiagramCategory | undefined;
  readonly isError: boolean = false;
  readonly errorMessage?: string;
  readonly svgContent: string | null = null;

  #copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #renderIcon: (element: HTMLElement, iconId: string) => void;

  constructor(options: DiagramSurfaceOptions) {
    this.options = options;
    this.#renderIcon =
      options.iconRenderer ??
      ((el, icon) => {
        try {
          setIcon(el, icon);
        } catch {
          // Graceful fallback for non-Obsidian environments
        }
      });

    this.rootEl = createElement(
      options.container,
      "div",
      "hermesian-diagram-surface",
    );

    let renderResult = null;
    try {
      renderResult = render(options.source);
    } catch (err) {
      this.isError = true;
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (renderResult && !this.isError) {
      const detectedType =
        renderResult.type ??
        parseDiagramTypeFromSvg(renderResult.svg) ??
        "flowchart";
      this.type = detectedType;
      this.svgContent = renderResult.svg;
      const category = getDiagramCategory(detectedType);
      this.category = category;

      this.rootEl.classList.add(category === "wide" ? "is-wide" : "is-simple");
      this.rootEl.dataset.diagramType = detectedType;
      this.rootEl.dataset.diagramCategory = category;

      this.viewportEl = createElement(
        this.rootEl,
        "div",
        "hermesian-diagram-viewport",
      );
      this.viewportEl.innerHTML = renderResult.svg;

      const svgEl = this.viewportEl.querySelector("svg");
      if (svgEl) {
        if (category === "simple") {
          svgEl.style.width = "100%";
          svgEl.style.maxWidth = "100%";
          svgEl.style.height = "auto";
          svgEl.style.display = "block";
          this.viewportEl.style.overflowX = "hidden";
        } else {
          svgEl.style.maxWidth = "none";
          if (renderResult.width > 0) {
            svgEl.style.width = `${renderResult.width}px`;
          }
          if (renderResult.height > 0) {
            svgEl.style.height = `${renderResult.height}px`;
          }
          svgEl.style.flexShrink = "0";
          svgEl.style.display = "block";
          this.viewportEl.style.overflowX = "auto";
        }
      }
    } else {
      this.isError = true;
      this.rootEl.classList.add("is-error");

      this.errorEl = createElement(
        this.rootEl,
        "div",
        "hermesian-diagram-error",
      );

      const iconEl = createElement(
        this.errorEl,
        "span",
        "hermesian-diagram-error-icon",
      );
      this.#renderIcon(iconEl, "alert-triangle");

      const textEl = createElement(
        this.errorEl,
        "span",
        "hermesian-diagram-error-text",
      );
      textEl.textContent = "图表语法有误，无法渲染";

      this.toggleSourceButtonEl = createElement(
        this.errorEl,
        "button",
        "hermesian-diagram-toggle-source",
        {
          type: "button",
          "aria-expanded": "false",
        },
      );
      this.toggleSourceButtonEl.textContent = "查看源码";

      this.sourceEl = createElement(
        this.rootEl,
        "div",
        "hermesian-diagram-source",
      );
      this.sourceEl.style.display = "none";
      const preEl = createElement(this.sourceEl, "pre");
      const codeEl = createElement(preEl, "code", "language-mermaid");
      codeEl.textContent = options.source;

      this.toggleSourceButtonEl.addEventListener("click", () => {
        if (!this.sourceEl || !this.toggleSourceButtonEl) {
          return;
        }
        const isHidden = this.sourceEl.style.display === "none";
        this.sourceEl.style.display = isHidden ? "block" : "none";
        this.toggleSourceButtonEl.setAttribute(
          "aria-expanded",
          isHidden ? "true" : "false",
        );
        this.toggleSourceButtonEl.textContent = isHidden
          ? "收起源码"
          : "查看源码";
      });
    }

    // Bottom action toolbar
    this.toolbarEl = createElement(
      this.rootEl,
      "div",
      "hermesian-diagram-toolbar",
    );

    // 1. Expand button
    this.expandButtonEl = createElement(
      this.toolbarEl,
      "button",
      "hermesian-diagram-button hermesian-diagram-btn-expand",
      {
        type: "button",
        "aria-label": "放大",
        title: "放大",
        "data-action": "expand",
      },
    );
    this.#renderIcon(this.expandButtonEl, "maximize-2");
    if (this.isError) {
      this.expandButtonEl.disabled = true;
    } else {
      this.expandButtonEl.addEventListener("click", () => {
        if (this.options.onExpand) {
          this.options.onExpand();
        } else if (this.options.app && this.svgContent) {
          this.openModal();
        }
      });
    }

    // 2. Export PNG button
    this.exportButtonEl = createElement(
      this.toolbarEl,
      "button",
      "hermesian-diagram-button hermesian-diagram-btn-export",
      {
        type: "button",
        "aria-label": "导出 PNG",
        title: "导出 PNG",
        "data-action": "export-png",
      },
    );
    this.#renderIcon(this.exportButtonEl, "download");
    if (this.isError) {
      this.exportButtonEl.disabled = true;
    } else {
      this.exportButtonEl.addEventListener("click", () => {
        void this.#handleExportPng();
      });
    }

    // 3. Copy source button
    this.copyButtonEl = createElement(
      this.toolbarEl,
      "button",
      "hermesian-diagram-button hermesian-diagram-btn-copy",
      {
        type: "button",
        "aria-label": "复制源码",
        title: "复制源码",
        "data-action": "copy-source",
      },
    );
    this.#renderIcon(this.copyButtonEl, "copy");
    this.copyButtonEl.addEventListener("click", () => {
      void this.#handleCopySource();
    });
  }

  /**
   * Opens the full-size DiagramModal for this diagram if App is provided and SVG was rendered.
   */
  openModal(): DiagramModal | null {
    if (!this.svgContent || !this.options.app) {
      return null;
    }
    const modal = new DiagramModal(
      this.options.app,
      this.svgContent,
      this.options.source,
    );
    modal.open();
    return modal;
  }

  /**
   * Triggers the PNG export flow: renders SVG to PNG blob and saves to disk.
   */
  async exportPng(): Promise<void> {
    await this.#handleExportPng();
  }

  async #handleExportPng(): Promise<void> {
    if (this.options.onExportPng) {
      this.options.onExportPng();
      return;
    }
    if (!this.svgContent) {
      return;
    }
    try {
      const blob = this.options.pngExporter
        ? await this.options.pngExporter(this.svgContent)
        : await svgToPngBlob(this.svgContent, {
            container: this.rootEl,
            doc: this.rootEl.ownerDocument,
          });
      if (this.options.fileSaver) {
        await this.options.fileSaver(blob);
      } else if (this.options.app) {
        await savePngToFile({ app: this.options.app, blob });
      }
    } catch (err) {
      console.error("DiagramSurface: exportPng failed", err);
      try {
        new Notice("导出 PNG 失败");
      } catch {
        // ignore
      }
    }
  }

  /**
   * Programmatically copies the diagram Mermaid source and triggers copied visual feedback.
   */
  async copySource(): Promise<void> {
    await this.#handleCopySource();
  }

  async #handleCopySource(): Promise<void> {
    if (this.options.onCopySource) {
      this.options.onCopySource();
    }
    await copyTextToClipboard(this.options.source, this.options.clipboard);

    if (this.#copyResetTimer !== null) {
      clearTimeout(this.#copyResetTimer);
      this.#copyResetTimer = null;
    }
    this.copyButtonEl.classList.add("is-copied");
    this.copyButtonEl.setAttribute("aria-label", "已复制");
    this.copyButtonEl.title = "已复制";
    this.#renderIcon(this.copyButtonEl, "check");

    this.#copyResetTimer = setTimeout(() => {
      this.#copyResetTimer = null;
      this.copyButtonEl.classList.remove("is-copied");
      this.copyButtonEl.setAttribute("aria-label", "复制源码");
      this.copyButtonEl.title = "复制源码";
      this.#renderIcon(this.copyButtonEl, "copy");
    }, 2000);
  }

  destroy(): void {
    if (this.#copyResetTimer !== null) {
      clearTimeout(this.#copyResetTimer);
      this.#copyResetTimer = null;
    }
    this.rootEl.remove();
  }
}

/**
 * Convenience helper to instantiate and mount a DiagramSurface.
 */
export function renderDiagramSurface(
  options: DiagramSurfaceOptions,
): DiagramSurface {
  return new DiagramSurface(options);
}
