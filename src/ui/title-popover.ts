import { resolveDownwardPickerPlacement } from "./picker-geometry";

export interface HermesTitlePopoverOptions {
  anchorEl: HTMLElement;
  tabId: string;
  tabLabel: number;
  currentTitle: string;
  hasCustomTitle: boolean;
  canGenerateAi: boolean;
  onRename: (nextTitle: string) => Promise<string>;
  onGenerateAi: () => Promise<string>;
  onClose?: () => void;
  getViewport?: () => { height: number; width: number };
  getContainerRect?: () => { left: number; width: number };
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

const POPOVER_HEIGHT_MAX = 320;
const OPEN_ANIMATION_DELAY_MS = 20;

export class HermesTitlePopover {
  private readonly options: HermesTitlePopoverOptions;
  private currentTitle: string;
  private hasCustomTitle: boolean;
  private canGenerateAi: boolean;
  private isOpenFlag = false;
  private isEditing = false;
  private isBusy = false;
  private openFrame = 0;
  private reducedMotionClassAdded = false;

  private readonly containerEl: HTMLElement;
  private readonly displayEl: HTMLButtonElement;
  private readonly titleTextEl: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private readonly aiButtonEl: HTMLButtonElement;
  private readonly aiButtonLabelEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly iconRenderer: (element: HTMLElement, icon: string) => void;

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpenFlag) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.isEditing) {
        this.exitEditMode();
      } else {
        this.detach();
      }
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.isOpenFlag) {
      return;
    }
    const target = event.target as Node | null;
    if (
      !target ||
      this.containerEl.contains(target) ||
      this.options.anchorEl.contains(target)
    ) {
      return;
    }
    this.detach();
  };

  private readonly onResize = (): void => {
    this.position();
  };

  constructor(options: HermesTitlePopoverOptions) {
    this.options = options;
    this.currentTitle = options.currentTitle;
    this.hasCustomTitle = options.hasCustomTitle;
    this.canGenerateAi = options.canGenerateAi;
    this.iconRenderer = options.iconRenderer ?? (() => {});

    this.containerEl = document.createElement("div");
    this.containerEl.className = "hermesian-title-popover";
    this.containerEl.tabIndex = -1;
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-label", "Conversation title");

    // Header (no close button inside popover per Q1)
    const headerEl = document.createElement("div");
    headerEl.className = "hermesian-title-popover-header";

    const headingEl = document.createElement("div");
    headingEl.className = "hermesian-title-popover-heading";
    headingEl.textContent = `CONVERSATION ${options.tabLabel}`;
    headerEl.appendChild(headingEl);

    // Body
    const bodyEl = document.createElement("div");
    bodyEl.className = "hermesian-title-popover-body";

    // Display row (clickable to edit)
    this.displayEl = document.createElement("button");
    this.displayEl.type = "button";
    this.displayEl.className = "hermesian-title-popover-display";
    this.displayEl.title = "点击修改标题";

    this.titleTextEl = document.createElement("span");
    this.titleTextEl.className = "hermesian-title-popover-title-text";
    this.titleTextEl.textContent = this.currentTitle;

    const pencilIconEl = document.createElement("span");
    pencilIconEl.className = "hermesian-title-popover-pencil-icon";
    this.iconRenderer(pencilIconEl, "pencil");

    this.displayEl.append(this.titleTextEl, pencilIconEl);
    this.displayEl.addEventListener("click", () => {
      this.enterEditMode();
    });

    // Input row (revealed when editing)
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "hermesian-title-popover-input";
    this.inputEl.maxLength = 120;
    this.inputEl.placeholder = "输入会话标题，按 Enter 保存";
    this.inputEl.style.display = "none";
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void this.submitRename();
      }
    });

    // Actions row (AI generate button)
    const actionsEl = document.createElement("div");
    actionsEl.className = "hermesian-title-popover-actions";

    this.aiButtonEl = document.createElement("button");
    this.aiButtonEl.type = "button";
    this.aiButtonEl.className = "hermesian-title-popover-ai-button";

    const aiIconEl = document.createElement("span");
    aiIconEl.className = "hermesian-title-popover-ai-icon";
    this.iconRenderer(aiIconEl, "sparkles");

    this.aiButtonLabelEl = document.createElement("span");
    this.aiButtonLabelEl.className = "hermesian-title-popover-ai-label";
    this.aiButtonLabelEl.textContent = "AI 生成标题";

    this.aiButtonEl.append(aiIconEl, this.aiButtonLabelEl);
    this.updateAiButtonState();

    this.aiButtonEl.addEventListener("click", () => {
      void this.runAiGenerate();
    });
    actionsEl.appendChild(this.aiButtonEl);

    // Error alert
    this.errorEl = document.createElement("div");
    this.errorEl.className = "hermesian-title-popover-error";
    this.errorEl.setAttribute("role", "alert");
    this.errorEl.style.display = "none";

    bodyEl.append(this.displayEl, this.inputEl, actionsEl, this.errorEl);
    this.containerEl.append(headerEl, bodyEl);
  }

  open(): void {
    if (this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = true;
    document.body.appendChild(this.containerEl);
    this.applyReducedMotion(true);
    this.position();
    this.openFrame = window.setTimeout(() => {
      this.containerEl.classList.add("hermesian-title-popover--open");
    }, OPEN_ANIMATION_DELAY_MS);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    window.addEventListener("resize", this.onResize);
    this.displayEl.focus();
  }

  detach(): void {
    if (!this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = false;
    window.clearTimeout(this.openFrame);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    window.removeEventListener("resize", this.onResize);
    this.containerEl.remove();
    this.applyReducedMotion(false);
    this.options.anchorEl.focus();
    this.options.onClose?.();
  }

  isOpen(): boolean {
    return this.isOpenFlag;
  }

  getTabId(): string {
    return this.options.tabId;
  }

  updateAnchor(newAnchorEl: HTMLElement): void {
    this.options.anchorEl = newAnchorEl;
    if (this.isOpenFlag) {
      this.position();
    }
  }

  updateExternalTitle(
    title: string,
    options?: { hasCustomTitle?: boolean; canGenerateAi?: boolean },
  ): void {
    if (options?.hasCustomTitle !== undefined) {
      this.hasCustomTitle = options.hasCustomTitle;
    }
    if (options?.canGenerateAi !== undefined) {
      this.canGenerateAi = options.canGenerateAi;
      if (!this.isBusy) {
        this.updateAiButtonState();
      }
    }
    if (this.isEditing || this.isBusy) {
      return;
    }
    this.currentTitle = title;
    this.titleTextEl.textContent = title;
  }

  private enterEditMode(): void {
    if (this.isBusy) {
      return;
    }
    this.isEditing = true;
    this.clearError();
    this.displayEl.style.display = "none";
    this.inputEl.style.display = "";

    if (this.hasCustomTitle) {
      this.inputEl.value = this.currentTitle;
      this.inputEl.select();
    } else if (this.currentTitle !== "未命名会话") {
      this.inputEl.value = this.currentTitle;
      this.inputEl.select();
    } else {
      this.inputEl.value = "";
    }
    this.inputEl.focus();
  }

  private exitEditMode(): void {
    this.isEditing = false;
    this.clearError();
    this.inputEl.style.display = "none";
    this.displayEl.style.display = "";
    this.titleTextEl.textContent = this.currentTitle;
    this.displayEl.focus();
  }

  private showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.style.display = "";
  }

  private clearError(): void {
    this.errorEl.textContent = "";
    this.errorEl.style.display = "none";
  }

  private updateAiButtonState(): void {
    if (this.canGenerateAi) {
      this.aiButtonEl.disabled = this.isBusy;
      this.aiButtonEl.title = "使用 AI 生成会话标题";
      this.aiButtonEl.removeAttribute("aria-disabled");
    } else {
      this.aiButtonEl.disabled = true;
      this.aiButtonEl.title = "发送消息后可用";
      this.aiButtonEl.setAttribute("aria-disabled", "true");
    }
  }

  private setBusy(busy: boolean, isAi = false): void {
    this.isBusy = busy;
    this.inputEl.disabled = busy;
    if (busy) {
      if (isAi) {
        this.aiButtonLabelEl.textContent = "生成中…";
      }
      this.aiButtonEl.disabled = true;
    } else {
      this.aiButtonLabelEl.textContent = "AI 生成标题";
      this.updateAiButtonState();
    }
  }

  private async submitRename(): Promise<void> {
    const trimmed = this.inputEl.value.trim();
    if (!trimmed) {
      this.showError("标题不能为空");
      this.inputEl.focus();
      return;
    }
    if (trimmed === this.currentTitle && this.hasCustomTitle) {
      this.exitEditMode();
      return;
    }

    this.setBusy(true);
    this.clearError();
    try {
      const savedTitle = await this.options.onRename(trimmed);
      this.currentTitle = savedTitle;
      this.hasCustomTitle = true;
      this.titleTextEl.textContent = savedTitle;
      this.exitEditMode();
      this.clearError();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(message);
      this.titleTextEl.textContent = this.currentTitle;
      this.inputEl.focus();
    } finally {
      this.setBusy(false);
    }
  }

  private async runAiGenerate(): Promise<void> {
    if (this.isBusy || !this.canGenerateAi) {
      return;
    }
    this.setBusy(true, true);
    this.clearError();
    try {
      const savedTitle = await this.options.onGenerateAi();
      this.currentTitle = savedTitle;
      this.hasCustomTitle = true;
      this.titleTextEl.textContent = savedTitle;
      if (this.isEditing) {
        this.exitEditMode();
      }
      this.clearError();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showError(message);
      this.titleTextEl.textContent = this.currentTitle;
    } finally {
      this.setBusy(false);
      if (this.isOpenFlag && !this.isEditing) {
        this.displayEl.focus();
      }
    }
  }

  private position(): void {
    const viewport =
      this.options.getViewport?.() ?? {
        height: window.innerHeight,
        width: window.innerWidth,
      };
    const containerRect = this.options.getContainerRect?.() ?? {
      left: 0,
      width: viewport.width,
    };
    const rect = this.options.anchorEl.getBoundingClientRect();
    const placement = resolveDownwardPickerPlacement({
      anchorRect: { bottom: rect.bottom },
      containerRect,
      viewport,
      popoverHeightMax: POPOVER_HEIGHT_MAX,
    });
    this.containerEl.style.width = `${placement.width}px`;
    this.containerEl.style.left = `${placement.left}px`;
    this.containerEl.style.top = `${placement.top}px`;
    this.containerEl.style.maxHeight = `${placement.height}px`;
  }

  private applyReducedMotion(add: boolean): void {
    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced && add && !this.reducedMotionClassAdded) {
      document.body.classList.add("hermesian-reduced-motion");
      this.reducedMotionClassAdded = true;
    } else if (!add && this.reducedMotionClassAdded) {
      document.body.classList.remove("hermesian-reduced-motion");
      this.reducedMotionClassAdded = false;
    }
  }
}
