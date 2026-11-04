import { type App, Modal } from "obsidian";

/**
 * Options for TableModal.
 */
export interface TableModalOptions {
  /**
   * Source file path for resolving relative internal links.
   */
  sourcePath?: string;
  /**
   * Custom link click handler override.
   */
  onLinkClick?: (event: MouseEvent) => void;
}

/**
 * Handles click events on links rendered inside markdown containers
 * (both in the sidebar and in full-size modals).
 *
 * Supports internal Obsidian links ([[Page]] / .internal-link) and
 * external http/https links.
 *
 * Returns true if a link click was handled, false otherwise.
 */
export function handleRenderedLinkClick(
  event: MouseEvent,
  app: App,
  defaultSourcePath?: string,
): boolean {
  const eventTarget = event.target;
  const anchor =
    eventTarget && typeof (eventTarget as any).closest === "function"
      ? ((eventTarget as any).closest("a") as HTMLAnchorElement | null)
      : null;
  if (!anchor) {
    return false;
  }

  const isInternal =
    (typeof (anchor as any).hasClass === "function" &&
      (anchor as any).hasClass("internal-link")) ||
    anchor.classList.contains("internal-link");

  if (!isInternal) {
    const href = anchor.getAttribute("href");
    if (!href) {
      return false;
    }
    try {
      const url = new URL(href);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      window.open(url.toString(), "_blank", "noopener,noreferrer");
      return true;
    } catch {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
  }

  const linkText = anchor.dataset?.href ?? anchor.getAttribute("href");
  if (!linkText) {
    return false;
  }
  const sourcePath =
    anchor.closest<HTMLElement>("[data-source-path]")?.dataset?.sourcePath ??
    anchor.closest<HTMLElement>(".hermesian-message-content")?.dataset?.sourcePath ??
    defaultSourcePath ??
    "";
  event.preventDefault();
  event.stopPropagation();
  void app.workspace.openLinkText(
    linkText,
    sourcePath,
    event.metaKey || event.ctrlKey,
  );
  return true;
}

/**
 * Lightweight modal for viewing full-size markdown tables with
 * bidirectional scrolling and frozen (sticky) row and column headers.
 */
export class TableModal extends Modal {
  readonly tableEl: HTMLElement;
  readonly options: TableModalOptions;

  viewportEl: HTMLElement | null = null;
  closeBtnEl: HTMLButtonElement | null = null;
  readonly #handleLinkClick: (event: MouseEvent) => void;

  constructor(
    app: App,
    tableEl: HTMLElement,
    options: TableModalOptions = {},
  ) {
    super(app);
    // Clone to ensure independence from source DOM
    this.tableEl = tableEl.cloneNode(true) as HTMLElement;
    this.options = options;

    this.#handleLinkClick = (event: MouseEvent) => {
      if (this.options.onLinkClick) {
        this.options.onLinkClick(event);
      } else {
        handleRenderedLinkClick(event, this.app, this.options.sourcePath);
      }
    };
  }

  onOpen(): void {
    super.onOpen?.();

    this.setTitle("表格查看");
    this.modalEl.classList.add("hermesian-table-modal");

    // Clear existing content
    if (typeof (this.contentEl as any).empty === "function") {
      (this.contentEl as any).empty();
    }
    this.contentEl.innerHTML = "";

    const contentWrapper = document.createElement("div");
    contentWrapper.className = "hermesian-table-modal-content";
    this.contentEl.appendChild(contentWrapper);

    // Viewport with bidirectional scrolling and sticky headers
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "hermesian-table-modal-viewport";
    if (this.options.sourcePath) {
      this.viewportEl.dataset.sourcePath = this.options.sourcePath;
    }
    this.viewportEl.appendChild(this.tableEl);
    this.viewportEl.addEventListener("click", this.#handleLinkClick);
    contentWrapper.appendChild(this.viewportEl);

    // Footer with explicit Close button
    const footer = document.createElement("div");
    footer.className = "hermesian-table-modal-footer";

    this.closeBtnEl = document.createElement("button");
    this.closeBtnEl.className =
      "hermesian-table-modal-btn hermesian-table-modal-close-btn";
    this.closeBtnEl.type = "button";
    this.closeBtnEl.textContent = "关闭";
    this.closeBtnEl.addEventListener("click", () => {
      this.close();
    });
    footer.appendChild(this.closeBtnEl);

    contentWrapper.appendChild(footer);
  }

  onClose(): void {
    if (this.viewportEl) {
      this.viewportEl.removeEventListener("click", this.#handleLinkClick);
    }
    if (typeof (this.contentEl as any).empty === "function") {
      (this.contentEl as any).empty();
    }
    this.contentEl.innerHTML = "";
    this.viewportEl = null;
    this.closeBtnEl = null;
    super.onClose?.();
  }
}
