import { type App, Modal, Notice, setIcon } from "obsidian";

/**
 * Standard zoom levels available for DiagramModal.
 */
export const ZOOM_LEVELS: readonly number[] = [
  0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0,
];

export const DEFAULT_ZOOM = 1.0;

/**
 * Pele CSS variables injected into SVG export for theme fidelity.
 */
export const PELE_CSS_VARIABLES: readonly string[] = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-error",
  "--pele-critical",
  "--pele-radius",
  "--pele-font",
  "--pele-font-mono",
];

export interface SvgDimensions {
  width: number;
  height: number;
}

/**
 * Extracts width and height from SVG attributes or viewBox.
 */
export function parseSvgDimensions(svgContent: string): SvgDimensions {
  const widthAttr = svgContent.match(/\bwidth="([0-9.]+)(?:px)?"/i);
  const heightAttr = svgContent.match(/\bheight="([0-9.]+)(?:px)?"/i);
  const w = widthAttr ? parseFloat(widthAttr[1]) : 0;
  const h = heightAttr ? parseFloat(heightAttr[1]) : 0;

  if (w > 0 && h > 0) {
    return { width: Math.round(w), height: Math.round(h) };
  }

  const viewBoxAttr = svgContent.match(/\bviewBox="([^"]+)"/i);
  if (viewBoxAttr) {
    const parts = viewBoxAttr[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
    }
  }

  return { width: Math.round(w || 800), height: Math.round(h || 600) };
}

/**
 * Generates default export filename: diagram-${YYYYMMDD-HHmmss}.png
 */
export function getDiagramFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `diagram-${yyyy}${mm}${dd}-${hh}${min}${ss}.png`;
}

export interface ResolvedStyles {
  cssDeclarations: string;
  backgroundColor: string;
  variables: Record<string, string>;
}

/**
 * Resolves Pele theme CSS variables from the DOM so SVG exports
 * retain exact colors even when rendered in an isolated image context.
 */
export function resolvePeleStyles(
  doc?: Document,
  container?: HTMLElement,
): ResolvedStyles {
  const d = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!d) {
    return {
      cssDeclarations: "",
      backgroundColor: "#ffffff",
      variables: {},
    };
  }

  let tempEl: HTMLElement | null = null;
  let target = container;

  if (!target) {
    tempEl = d.createElement("div");
    tempEl.className = "hermesian-diagram-surface";
    tempEl.style.position = "fixed";
    tempEl.style.opacity = "0";
    tempEl.style.pointerEvents = "none";
    (d.body || d.documentElement).appendChild(tempEl);
    target = tempEl;
  }

  const variables: Record<string, string> = {};
  const decls: string[] = [];
  let backgroundColor = "#ffffff";

  try {
    const defaultView =
      d.defaultView ?? (typeof window !== "undefined" ? window : null);
    const computed = defaultView?.getComputedStyle?.(target);
    if (computed) {
      for (const varName of PELE_CSS_VARIABLES) {
        const val = computed.getPropertyValue(varName)?.trim();
        if (val) {
          variables[varName] = val;
          decls.push(`${varName}: ${val};`);
          if (varName === "--pele-bg") {
            backgroundColor = val;
          }
        }
      }
    }
  } finally {
    if (tempEl) {
      tempEl.remove();
    }
  }

  return {
    cssDeclarations: decls.join(" "),
    backgroundColor,
    variables,
  };
}

/**
 * Inlines computed styles and namespaces into an SVG string for clean export.
 */
export function prepareSvgForExport(
  svgContent: string,
  styles?: ResolvedStyles,
): string {
  let svg = svgContent.trim();
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const dims = parseSvgDimensions(svg);
  if (!svg.match(/\bwidth="[\d.]+(?:px)?"/i)) {
    svg = svg.replace("<svg", `<svg width="${dims.width}"`);
  }
  if (!svg.match(/\bheight="[\d.]+(?:px)?"/i)) {
    svg = svg.replace("<svg", `<svg height="${dims.height}"`);
  }

  if (styles?.cssDeclarations) {
    const styleTag = `<style>:root, svg { ${styles.cssDeclarations} }</style>`;
    const tagEnd = svg.indexOf(">");
    if (tagEnd !== -1) {
      svg = svg.slice(0, tagEnd + 1) + styleTag + svg.slice(tagEnd + 1);
    }
  }

  return svg;
}

export interface SvgToPngOptions {
  /** Scale multiplier, defaults to 2 (Retina sharpness) */
  scale?: number;
  /** Background fill color. Defaults to DOM --pele-bg or "#ffffff" */
  backgroundColor?: string;
  /** DOM container used for CSS variable resolution */
  container?: HTMLElement;
  /** Document instance for DOM operations */
  doc?: Document;
  /** Custom canvas factory (for testing or non-browser environments) */
  createCanvas?: (
    width: number,
    height: number,
  ) => {
    getContext(type: "2d"): any;
    toBlob?(
      callback: (blob: Blob | null) => void,
      type?: string,
      quality?: any,
    ): void;
    toDataURL?(type?: string, quality?: any): string;
  };
  /** Custom Image factory (for testing) */
  createImage?: () => {
    onload: (() => void) | null;
    onerror: ((err: any) => void) | null;
    src: string;
    width?: number;
    height?: number;
  };
}

/**
 * Converts a pele SVG string into a high-resolution PNG Blob via Canvas.
 */
export async function svgToPngBlob(
  svgContent: string,
  options: SvgToPngOptions = {},
): Promise<Blob> {
  const d = options.doc ?? (typeof document !== "undefined" ? document : undefined);
  const dims = parseSvgDimensions(svgContent);
  const scale = options.scale ?? 2;
  const width = Math.round(dims.width * scale);
  const height = Math.round(dims.height * scale);

  const resolved = resolvePeleStyles(d, options.container);
  const bgColor = options.backgroundColor ?? resolved.backgroundColor;
  const preparedSvg = prepareSvgForExport(svgContent, resolved);

  let srcUrl = "";
  let revokeUrl: (() => void) | null = null;

  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const blob = new Blob([preparedSvg], {
      type: "image/svg+xml;charset=utf-8",
    });
    srcUrl = URL.createObjectURL(blob);
    revokeUrl = () => URL.revokeObjectURL(srcUrl);
  } else {
    const base64 =
      typeof Buffer !== "undefined"
        ? Buffer.from(preparedSvg, "utf-8").toString("base64")
        : btoa(unescape(encodeURIComponent(preparedSvg)));
    srcUrl = `data:image/svg+xml;base64,${base64}`;
  }

  const img: any = options.createImage
    ? options.createImage()
    : typeof Image !== "undefined"
      ? new Image()
      : null;

  if (!img) {
    if (revokeUrl) revokeUrl();
    throw new Error("Image constructor not available in current environment");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () =>
        reject(new Error("Failed to load SVG into Image for PNG conversion"));
      img.src = srcUrl;
    });
  } finally {
    if (revokeUrl) {
      revokeUrl();
    }
  }

  let canvas: any;
  if (options.createCanvas) {
    canvas = options.createCanvas(width, height);
  } else {
    if (!d) {
      throw new Error("Document not available to create canvas element");
    }
    canvas = d.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext?.("2d");
  if (!ctx) {
    throw new Error("Unable to obtain 2D rendering context from canvas");
  }

  if (bgColor && bgColor !== "transparent") {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.drawImage(img, 0, 0, width, height);

  if (typeof canvas.toBlob === "function") {
    const blob: Blob | null = await new Promise((resolve) => {
      canvas.toBlob((b: Blob | null) => resolve(b), "image/png");
    });
    if (blob) {
      return blob;
    }
  }

  if (typeof canvas.toDataURL === "function") {
    const dataUrl = canvas.toDataURL("image/png");
    const base64Data = dataUrl.split(",")[1] ?? dataUrl;
    const binary =
      typeof atob !== "undefined"
        ? atob(base64Data)
        : Buffer.from(base64Data, "base64").toString("binary");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: "image/png" });
  }

  throw new Error("Canvas does not support toBlob or toDataURL");
}

/**
 * Copies a PNG Blob to the system clipboard via navigator.clipboard.write(ClipboardItem).
 */
export async function copyPngToClipboard(
  blob: Blob,
  clipboard?: { write?(items: any[]): Promise<void> } | any,
): Promise<boolean> {
  try {
    const cb =
      clipboard ??
      (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
    if (!cb || typeof cb.write !== "function") {
      return false;
    }

    const ClipboardItemCtor =
      typeof ClipboardItem !== "undefined"
        ? ClipboardItem
        : (globalThis as any).ClipboardItem;
    if (!ClipboardItemCtor) {
      return false;
    }

    const item = new ClipboardItemCtor({
      "image/png": blob,
    });
    await cb.write([item]);
    return true;
  } catch (err) {
    console.error("Failed to copy PNG to clipboard:", err);
    return false;
  }
}

/**
 * Copies plain text to the clipboard with fallbacks.
 */
export async function copyTextToClipboard(
  text: string,
  customClipboard?: { writeText?(text: string): Promise<void> } | any,
): Promise<boolean> {
  try {
    if (customClipboard && typeof customClipboard.writeText === "function") {
      await customClipboard.writeText(text);
      return true;
    }
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    try {
      if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (success) {
          return true;
        }
      }
    } catch {
      // Ignore fallback failures
    }
  }
  return false;
}

let lastSavedDirectory: string | null = null;

export function getLastSavedDirectory(): string | null {
  return lastSavedDirectory;
}

export function setLastSavedDirectory(dir: string | null): void {
  lastSavedDirectory = dir;
}

function resolveElectronDialog(): {
  showSaveDialog(
    options: any,
  ): Promise<{ canceled: boolean; filePath?: string }>;
} | null {
  try {
    const electron = require("electron");
    if (
      electron?.remote?.dialog &&
      typeof electron.remote.dialog.showSaveDialog === "function"
    ) {
      return electron.remote.dialog;
    }
    if (
      electron?.dialog &&
      typeof electron.dialog.showSaveDialog === "function"
    ) {
      return electron.dialog;
    }
  } catch {
    // not in electron
  }
  try {
    const remote = require("@electron/remote");
    if (remote?.dialog && typeof remote.dialog.showSaveDialog === "function") {
      return remote.dialog;
    }
  } catch {
    // remote not available
  }
  return null;
}

export interface SavePngOptions {
  app: App;
  blob: Blob;
  filename?: string;
  dialog?: {
    showSaveDialog(
      options: any,
    ): Promise<{ canceled: boolean; filePath?: string }>;
  };
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
  showNotice?: (message: string) => void;
  lastSavedDir?: string | null;
}

/**
 * Saves a PNG Blob to disk using Electron's showSaveDialog with fallbacks.
 */
export async function savePngToFile(
  options: SavePngOptions,
): Promise<string | null> {
  const filename = options.filename ?? getDiagramFilename();
  const effectiveLastDir =
    options.lastSavedDir !== undefined
      ? options.lastSavedDir
      : lastSavedDirectory;

  let initialPath = filename;
  if (effectiveLastDir) {
    try {
      const path = require("node:path");
      initialPath = path.join(effectiveLastDir, filename);
    } catch {
      initialPath = `${effectiveLastDir}/${filename}`;
    }
  } else {
    try {
      const attachmentPath =
        await options.app.fileManager.getAvailablePathForAttachment(
          "diagram.png",
        );
      const basePath = (options.app.vault.adapter as any)?.getBasePath?.();
      const path = require("node:path");
      if (basePath && typeof basePath === "string") {
        const fullAttachmentDir = path.dirname(
          path.join(basePath, attachmentPath),
        );
        initialPath = path.join(fullAttachmentDir, filename);
      } else {
        const dir =
          attachmentPath.includes("/") || attachmentPath.includes("\\")
            ? path.dirname(attachmentPath)
            : "";
        initialPath = dir ? path.join(dir, filename) : filename;
      }
    } catch {
      initialPath = filename;
    }
  }

  const dialog = options.dialog ?? resolveElectronDialog();
  if (dialog && typeof dialog.showSaveDialog === "function") {
    const result = await dialog.showSaveDialog({
      defaultPath: initialPath,
      filters: [
        { name: "PNG Image", extensions: ["png"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const filePath = result.filePath;
    const arrayBuffer = await options.blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (options.writeFile) {
      await options.writeFile(filePath, bytes);
    } else {
      const fs = require("node:fs/promises");
      await fs.writeFile(filePath, Buffer.from(bytes));
    }

    try {
      const path = require("node:path");
      lastSavedDirectory = path.dirname(filePath);
    } catch {
      // ignore
    }

    const notify =
      options.showNotice ??
      ((msg: string) => {
        try {
          new Notice(msg);
        } catch {
          // ignore
        }
      });
    notify(`图表已保存至: ${filePath}`);
    return filePath;
  }

  // Fallback: save to Obsidian vault attachment
  try {
    const targetAttachmentPath =
      await options.app.fileManager.getAvailablePathForAttachment(filename);
    const arrayBuffer = await options.blob.arrayBuffer();
    await options.app.vault.createBinary(targetAttachmentPath, arrayBuffer);
    const notify =
      options.showNotice ??
      ((msg: string) => {
        try {
          new Notice(msg);
        } catch {
          // ignore
        }
      });
    notify(`图表已保存至: ${targetAttachmentPath}`);
    return targetAttachmentPath;
  } catch (vaultErr) {
    if (typeof document !== "undefined" && typeof URL !== "undefined") {
      const url = URL.createObjectURL(options.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      const notify =
        options.showNotice ??
        ((msg: string) => {
          try {
            new Notice(msg);
          } catch {
            // ignore
          }
        });
      notify(`图表已下载: ${filename}`);
      return filename;
    }
    throw vaultErr;
  }
}

export interface DiagramModalOptions {
  /** Custom PNG converter (for testing) */
  svgToPng?: (svg: string) => Promise<Blob>;
  /** Custom clipboard interface (for testing) */
  clipboard?: {
    write?(items: any[]): Promise<void>;
    writeText?(text: string): Promise<void>;
  };
  /** Custom file saver (for testing) */
  fileSaver?: (blob: Blob) => Promise<string | null>;
  /** Custom source copy callback (for testing) */
  copySource?: (source: string) => Promise<boolean>;
  /** Custom icon renderer (defaults to Obsidian setIcon) */
  iconRenderer?: (element: HTMLElement, iconId: string) => void;
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
 * DiagramModal: Full-size diagram preview modal (Host-Native Surface)
 * with zoom controls and actions to export PNG, copy image, and copy source.
 */
export class DiagramModal extends Modal {
  readonly svgContent: string;
  readonly source: string;
  readonly modalOptions: DiagramModalOptions;

  zoom: number = DEFAULT_ZOOM;
  readonly baseWidth: number;
  readonly baseHeight: number;

  viewportEl: HTMLElement | null = null;
  svgContainerEl: HTMLElement | null = null;
  svgEl: SVGElement | null = null;
  zoomTextEl: HTMLElement | null = null;

  exportBtnEl: HTMLButtonElement | null = null;
  copyPngBtnEl: HTMLButtonElement | null = null;
  copyPngIconEl: HTMLElement | null = null;
  copyPngTextEl: HTMLElement | null = null;
  copySourceBtnEl: HTMLButtonElement | null = null;
  copySourceIconEl: HTMLElement | null = null;
  copySourceTextEl: HTMLElement | null = null;
  closeBtnEl: HTMLButtonElement | null = null;

  #copyPngTimer: ReturnType<typeof setTimeout> | null = null;
  #copySourceTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #renderIcon: (element: HTMLElement, iconId: string) => void;

  constructor(
    app: App,
    svgContent: string,
    source: string,
    options: DiagramModalOptions = {},
  ) {
    super(app);
    this.svgContent = svgContent;
    this.source = source;
    this.modalOptions = options;

    const dims = parseSvgDimensions(svgContent);
    this.baseWidth = dims.width;
    this.baseHeight = dims.height;

    this.#renderIcon =
      options.iconRenderer ??
      ((el, icon) => {
        try {
          setIcon(el, icon);
        } catch {
          // Graceful fallback for non-Obsidian environments
        }
      });
  }

  onOpen(): void {
    super.onOpen?.();

    this.setTitle("图表预览");
    this.modalEl.classList.add("hermesian-diagram-modal");

    // Clear content element
    if (typeof (this.contentEl as any).empty === "function") {
      (this.contentEl as any).empty();
    }
    this.contentEl.innerHTML = "";

    const contentWrapper = createElement(
      this.contentEl,
      "div",
      "hermesian-diagram-modal-content",
    );

    // 1. Top Zoom Control Bar
    const zoomBar = createElement(
      contentWrapper,
      "div",
      "hermesian-diagram-modal-zoom-bar",
    );

    const zoomOutBtn = createElement(
      zoomBar,
      "button",
      "hermesian-diagram-modal-zoom-btn hermesian-diagram-btn-zoom-out",
      { type: "button", title: "缩小", "aria-label": "缩小" },
    );
    this.#renderIcon(zoomOutBtn, "zoom-out");
    if (!zoomOutBtn.textContent && !zoomOutBtn.firstElementChild) {
      zoomOutBtn.textContent = "−";
    }
    zoomOutBtn.addEventListener("click", () => this.zoomOut());

    this.zoomTextEl = createElement(
      zoomBar,
      "span",
      "hermesian-diagram-modal-zoom-text",
    );
    this.zoomTextEl.textContent = `${Math.round(this.zoom * 100)}%`;

    const zoomInBtn = createElement(
      zoomBar,
      "button",
      "hermesian-diagram-modal-zoom-btn hermesian-diagram-btn-zoom-in",
      { type: "button", title: "放大", "aria-label": "放大" },
    );
    this.#renderIcon(zoomInBtn, "zoom-in");
    if (!zoomInBtn.textContent && !zoomInBtn.firstElementChild) {
      zoomInBtn.textContent = "+";
    }
    zoomInBtn.addEventListener("click", () => this.zoomIn());

    const zoomResetBtn = createElement(
      zoomBar,
      "button",
      "hermesian-diagram-modal-zoom-btn hermesian-diagram-btn-zoom-reset",
      { type: "button", title: "重置缩放 (100%)", "aria-label": "重置缩放" },
    );
    zoomResetBtn.textContent = "重置";
    zoomResetBtn.addEventListener("click", () => this.resetZoom());

    // 2. Viewport & SVG Container
    this.viewportEl = createElement(
      contentWrapper,
      "div",
      "hermesian-diagram-modal-viewport",
    );

    this.svgContainerEl = createElement(
      this.viewportEl,
      "div",
      "hermesian-diagram-modal-svg-wrap",
    );
    this.svgContainerEl.innerHTML = this.svgContent;

    this.svgEl = this.svgContainerEl.querySelector("svg");
    if (this.svgEl) {
      this.svgEl.style.display = "block";
      this.svgEl.style.maxWidth = "none";
      this.svgEl.style.maxHeight = "none";
      this.svgEl.style.width = `${Math.round(this.baseWidth * this.zoom)}px`;
      this.svgEl.style.height = `${Math.round(this.baseHeight * this.zoom)}px`;
    }

    // Mouse wheel zoom with Ctrl/Cmd
    this.viewportEl.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.deltaY < 0) {
            this.zoomIn();
          } else if (e.deltaY > 0) {
            this.zoomOut();
          }
        }
      },
      { passive: false },
    );

    // 3. Bottom Toolbar
    const toolbarEl = createElement(
      contentWrapper,
      "div",
      "hermesian-diagram-modal-toolbar",
    );

    const leftActions = createElement(
      toolbarEl,
      "div",
      "hermesian-diagram-modal-actions-left",
    );

    // Export PNG button (Save to file)
    this.exportBtnEl = createElement(
      leftActions,
      "button",
      "hermesian-diagram-modal-btn mod-cta hermesian-diagram-btn-export-png",
      { type: "button", title: "导出 PNG 到文件", "aria-label": "导出 PNG" },
    );
    const exportIcon = createElement(
      this.exportBtnEl,
      "span",
      "hermesian-btn-icon",
    );
    this.#renderIcon(exportIcon, "download");
    const exportText = createElement(
      this.exportBtnEl,
      "span",
      "hermesian-btn-text",
    );
    exportText.textContent = "导出 PNG";
    this.exportBtnEl.addEventListener("click", () => {
      void this.exportPng();
    });

    // Copy PNG button (Copy to clipboard)
    this.copyPngBtnEl = createElement(
      leftActions,
      "button",
      "hermesian-diagram-modal-btn hermesian-diagram-btn-copy-png",
      { type: "button", title: "复制 PNG 到剪贴板", "aria-label": "复制图片" },
    );
    this.copyPngIconEl = createElement(
      this.copyPngBtnEl,
      "span",
      "hermesian-btn-icon",
    );
    this.#renderIcon(this.copyPngIconEl, "image");
    this.copyPngTextEl = createElement(
      this.copyPngBtnEl,
      "span",
      "hermesian-btn-text",
    );
    this.copyPngTextEl.textContent = "复制图片";
    this.copyPngBtnEl.addEventListener("click", () => {
      void this.copyPng();
    });

    // Copy Mermaid source button
    this.copySourceBtnEl = createElement(
      leftActions,
      "button",
      "hermesian-diagram-modal-btn hermesian-diagram-btn-copy-source",
      { type: "button", title: "复制 Mermaid 源码", "aria-label": "复制源码" },
    );
    this.copySourceIconEl = createElement(
      this.copySourceBtnEl,
      "span",
      "hermesian-btn-icon",
    );
    this.#renderIcon(this.copySourceIconEl, "copy");
    this.copySourceTextEl = createElement(
      this.copySourceBtnEl,
      "span",
      "hermesian-btn-text",
    );
    this.copySourceTextEl.textContent = "复制源码";
    this.copySourceBtnEl.addEventListener("click", () => {
      void this.copySource();
    });

    // Right action group: Close button
    const rightActions = createElement(
      toolbarEl,
      "div",
      "hermesian-diagram-modal-actions-right",
    );

    this.closeBtnEl = createElement(
      rightActions,
      "button",
      "hermesian-diagram-modal-btn hermesian-diagram-btn-close",
      { type: "button", title: "关闭", "aria-label": "关闭" },
    );
    this.closeBtnEl.textContent = "关闭";
    this.closeBtnEl.addEventListener("click", () => {
      this.close();
    });
  }

  onClose(): void {
    if (this.#copyPngTimer !== null) {
      clearTimeout(this.#copyPngTimer);
      this.#copyPngTimer = null;
    }
    if (this.#copySourceTimer !== null) {
      clearTimeout(this.#copySourceTimer);
      this.#copySourceTimer = null;
    }
    if (typeof (this.contentEl as any).empty === "function") {
      (this.contentEl as any).empty();
    }
    this.contentEl.innerHTML = "";
    super.onClose?.();
  }

  setZoom(level: number): void {
    const clamped = Math.max(
      0.25,
      Math.min(4.0, Math.round(level * 100) / 100),
    );
    this.zoom = clamped;

    if (this.zoomTextEl) {
      this.zoomTextEl.textContent = `${Math.round(clamped * 100)}%`;
    }

    if (this.svgEl) {
      const scaledW = Math.round(this.baseWidth * clamped);
      const scaledH = Math.round(this.baseHeight * clamped);
      this.svgEl.style.width = `${scaledW}px`;
      this.svgEl.style.height = `${scaledH}px`;
    }
  }

  zoomIn(): void {
    const next = ZOOM_LEVELS.find((lvl) => lvl > this.zoom + 0.01);
    this.setZoom(next ?? Math.min(4.0, this.zoom + 0.25));
  }

  zoomOut(): void {
    const prev = [...ZOOM_LEVELS]
      .reverse()
      .find((lvl) => lvl < this.zoom - 0.01);
    this.setZoom(prev ?? Math.max(0.25, this.zoom - 0.25));
  }

  resetZoom(): void {
    this.setZoom(DEFAULT_ZOOM);
  }

  async exportPng(): Promise<string | null> {
    try {
      if (this.exportBtnEl) {
        this.exportBtnEl.disabled = true;
      }
      const blob = this.modalOptions.svgToPng
        ? await this.modalOptions.svgToPng(this.svgContent)
        : await svgToPngBlob(this.svgContent, {
            container: this.svgContainerEl ?? undefined,
            doc: this.contentEl.ownerDocument,
          });

      let path: string | null = null;
      if (this.modalOptions.fileSaver) {
        path = await this.modalOptions.fileSaver(blob);
      } else {
        path = await savePngToFile({ app: this.app, blob });
      }
      return path;
    } catch (err) {
      console.error("DiagramModal: exportPng failed", err);
      try {
        new Notice("导出 PNG 失败");
      } catch {
        // ignore
      }
      return null;
    } finally {
      if (this.exportBtnEl) {
        this.exportBtnEl.disabled = false;
      }
    }
  }

  async copyPng(): Promise<boolean> {
    try {
      if (this.copyPngBtnEl) {
        this.copyPngBtnEl.disabled = true;
      }
      const blob = this.modalOptions.svgToPng
        ? await this.modalOptions.svgToPng(this.svgContent)
        : await svgToPngBlob(this.svgContent, {
            container: this.svgContainerEl ?? undefined,
            doc: this.contentEl.ownerDocument,
          });

      const success = await copyPngToClipboard(
        blob,
        this.modalOptions.clipboard,
      );
      if (success) {
        this.#triggerCopyPngFeedback();
        try {
          new Notice("图片已复制到剪贴板");
        } catch {
          // ignore
        }
        return true;
      } else {
        try {
          new Notice("无法复制图片到剪贴板，请检查权限");
        } catch {
          // ignore
        }
        return false;
      }
    } catch (err) {
      console.error("DiagramModal: copyPng failed", err);
      try {
        new Notice("复制图片失败");
      } catch {
        // ignore
      }
      return false;
    } finally {
      if (this.copyPngBtnEl) {
        this.copyPngBtnEl.disabled = false;
      }
    }
  }

  #triggerCopyPngFeedback(): void {
    if (this.#copyPngTimer !== null) {
      clearTimeout(this.#copyPngTimer);
      this.#copyPngTimer = null;
    }
    if (this.copyPngBtnEl) {
      this.copyPngBtnEl.classList.add("is-copied");
      this.copyPngBtnEl.setAttribute("aria-label", "已复制");
    }
    if (this.copyPngIconEl) {
      this.#renderIcon(this.copyPngIconEl, "check");
    }
    if (this.copyPngTextEl) {
      this.copyPngTextEl.textContent = "已复制";
    }

    this.#copyPngTimer = setTimeout(() => {
      this.#copyPngTimer = null;
      if (this.copyPngBtnEl) {
        this.copyPngBtnEl.classList.remove("is-copied");
        this.copyPngBtnEl.setAttribute("aria-label", "复制图片");
      }
      if (this.copyPngIconEl) {
        this.#renderIcon(this.copyPngIconEl, "image");
      }
      if (this.copyPngTextEl) {
        this.copyPngTextEl.textContent = "复制图片";
      }
    }, 2000);
  }

  async copySource(): Promise<boolean> {
    let success = false;
    if (this.modalOptions.copySource) {
      success = await this.modalOptions.copySource(this.source);
    } else {
      success = await copyTextToClipboard(
        this.source,
        this.modalOptions.clipboard,
      );
    }

    if (success) {
      this.#triggerCopySourceFeedback();
      try {
        new Notice("源码已复制到剪贴板");
      } catch {
        // ignore
      }
      return true;
    } else {
      try {
        new Notice("复制源码失败");
      } catch {
        // ignore
      }
      return false;
    }
  }

  #triggerCopySourceFeedback(): void {
    if (this.#copySourceTimer !== null) {
      clearTimeout(this.#copySourceTimer);
      this.#copySourceTimer = null;
    }
    if (this.copySourceBtnEl) {
      this.copySourceBtnEl.classList.add("is-copied");
      this.copySourceBtnEl.setAttribute("aria-label", "已复制");
    }
    if (this.copySourceIconEl) {
      this.#renderIcon(this.copySourceIconEl, "check");
    }
    if (this.copySourceTextEl) {
      this.copySourceTextEl.textContent = "已复制";
    }

    this.#copySourceTimer = setTimeout(() => {
      this.#copySourceTimer = null;
      if (this.copySourceBtnEl) {
        this.copySourceBtnEl.classList.remove("is-copied");
        this.copySourceBtnEl.setAttribute("aria-label", "复制源码");
      }
      if (this.copySourceIconEl) {
        this.#renderIcon(this.copySourceIconEl, "copy");
      }
      if (this.copySourceTextEl) {
        this.copySourceTextEl.textContent = "复制源码";
      }
    }, 2000);
  }
}
