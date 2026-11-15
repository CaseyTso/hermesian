import {
  calculateRemainingTokens,
  contextUsageLevel,
  contextUsagePercent,
  formatExactTokens,
  isValidContextUsage,
} from "../session-state";
import type { SessionContextUsage } from "../types";
import {
  CONTEXT_POPOVER_WIDTH,
  resolveAnchoredDownwardPlacement,
} from "./picker-geometry";

export interface HermesContextGaugePopoverOptions {
  anchorEl: HTMLElement;
  contextUsage: SessionContextUsage | undefined;
  canCompress: { available: boolean; reason?: string };
  onCompress: () => Promise<void> | void;
  onClose?: () => void;
  getViewport?: () => { height: number; width: number };
  getContainerRect?: () => { left: number; width: number };
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

const POPOVER_HEIGHT_MAX = 320;
const OPEN_ANIMATION_DELAY_MS = 20;
const RING_CIRCUMFERENCE = 100.53; // 2 * Math.PI * 16 ≈ 100.53096

export class HermesContextGaugePopover {
  private readonly options: HermesContextGaugePopoverOptions;
  private contextUsage: SessionContextUsage | undefined;
  private canCompress: { available: boolean; reason?: string };
  private isOpenFlag = false;
  private openFrame = 0;
  private reducedMotionClassAdded = false;

  private readonly containerEl: HTMLElement;
  private readonly arrowEl: HTMLElement;
  private readonly percentageEl: HTMLElement;
  private readonly ringFillEl: SVGCircleElement;
  private readonly usedValueEl: HTMLElement;
  private readonly totalValueEl: HTMLElement;
  private readonly remainingValueEl: HTMLElement;
  private readonly compressButtonEl: HTMLButtonElement;
  private readonly iconRenderer: (element: HTMLElement, icon: string) => void;

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

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpenFlag) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.detach();
    }
  };

  private readonly onResize = (): void => {
    this.position();
  };

  constructor(options: HermesContextGaugePopoverOptions) {
    this.options = options;
    this.contextUsage = options.contextUsage;
    this.canCompress = options.canCompress;
    this.iconRenderer = options.iconRenderer ?? (() => {});

    this.containerEl = document.createElement("div");
    this.containerEl.className = "hermesian-context-popover";
    this.containerEl.tabIndex = -1;
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-label", "上下文用量详情");

    // Arrow pointing to anchor
    this.arrowEl = document.createElement("div");
    this.arrowEl.className = "hermesian-context-popover-arrow";
    this.containerEl.appendChild(this.arrowEl);

    // Header
    const headerEl = document.createElement("div");
    headerEl.className = "hermesian-context-popover-header";
    const headingEl = document.createElement("div");
    headingEl.className = "hermesian-context-popover-heading";
    headingEl.textContent = "上下文用量";
    headerEl.appendChild(headingEl);
    this.containerEl.appendChild(headerEl);

    // Body
    const bodyEl = document.createElement("div");
    bodyEl.className = "hermesian-context-popover-body";

    // Hero: Ring gauge + percentage
    const heroEl = document.createElement("div");
    heroEl.className = "hermesian-context-popover-hero";

    const ringEl = document.createElement("div");
    ringEl.className = "hermesian-context-popover-ring";
    ringEl.innerHTML = `
      <svg viewBox="0 0 40 40" class="hermesian-context-popover-ring-svg">
        <circle class="hermesian-context-popover-track" cx="20" cy="20" r="16"></circle>
        <circle class="hermesian-context-popover-fill" cx="20" cy="20" r="16"></circle>
      </svg>
    `.trim();
    this.ringFillEl = ringEl.querySelector(
      ".hermesian-context-popover-fill",
    ) as SVGCircleElement;
    this.ringFillEl.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;

    const heroMetaEl = document.createElement("div");
    heroMetaEl.className = "hermesian-context-popover-hero-meta";

    this.percentageEl = document.createElement("div");
    this.percentageEl.className = "hermesian-context-popover-percentage";

    const heroLabelEl = document.createElement("div");
    heroLabelEl.className = "hermesian-context-popover-hero-label";
    heroLabelEl.textContent = "已使用";

    heroMetaEl.append(this.percentageEl, heroLabelEl);
    heroEl.append(ringEl, heroMetaEl);

    // Stats box
    const statsEl = document.createElement("div");
    statsEl.className = "hermesian-context-popover-stats";

    const createStatRow = (label: string): { rowEl: HTMLElement; valueEl: HTMLElement } => {
      const rowEl = document.createElement("div");
      rowEl.className = "hermesian-context-popover-stat-row";

      const labelEl = document.createElement("span");
      labelEl.className = "hermesian-context-popover-stat-label";
      labelEl.textContent = label;

      const valueEl = document.createElement("span");
      valueEl.className = "hermesian-context-popover-stat-value";

      rowEl.append(labelEl, valueEl);
      return { rowEl, valueEl };
    };

    const usedRow = createStatRow("已用");
    this.usedValueEl = usedRow.valueEl;

    const totalRow = createStatRow("总量");
    this.totalValueEl = totalRow.valueEl;

    const remainingRow = createStatRow("剩余可用");
    this.remainingValueEl = remainingRow.valueEl;

    statsEl.append(usedRow.rowEl, totalRow.rowEl, remainingRow.rowEl);

    // Actions
    const actionsEl = document.createElement("div");
    actionsEl.className = "hermesian-context-popover-actions";

    this.compressButtonEl = document.createElement("button");
    this.compressButtonEl.type = "button";
    this.compressButtonEl.className = "hermesian-context-popover-compress-btn";

    const iconEl = document.createElement("span");
    iconEl.className = "hermesian-context-popover-compress-icon";
    this.iconRenderer(iconEl, "fold-vertical");

    const buttonLabelEl = document.createElement("span");
    buttonLabelEl.className = "hermesian-context-popover-compress-label";
    buttonLabelEl.textContent = "压缩上下文";

    this.compressButtonEl.append(iconEl, buttonLabelEl);
    this.compressButtonEl.addEventListener("click", () => {
      if (this.canCompress.available) {
        this.detach();
        void this.options.onCompress();
      }
    });
    actionsEl.appendChild(this.compressButtonEl);

    bodyEl.append(heroEl, statsEl, actionsEl);
    this.containerEl.appendChild(bodyEl);

    this.renderData();
    this.updateCompressButtonState();
  }

  open(): void {
    if (this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = true;
    document.body.appendChild(this.containerEl);
    this.options.anchorEl.setAttribute("aria-expanded", "true");
    this.applyReducedMotion(true);
    this.position();
    this.openFrame = window.setTimeout(() => {
      this.containerEl.classList.add("hermesian-context-popover--open");
    }, OPEN_ANIMATION_DELAY_MS);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    window.addEventListener("resize", this.onResize);
    this.compressButtonEl.focus();
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
    this.options.anchorEl.setAttribute("aria-expanded", "false");
    this.containerEl.remove();
    this.applyReducedMotion(false);
    this.options.anchorEl.focus();
    this.options.onClose?.();
  }

  isOpen(): boolean {
    return this.isOpenFlag;
  }

  contains(target: Node): boolean {
    return this.isOpenFlag && this.containerEl.contains(target);
  }

  update(
    contextUsage: SessionContextUsage | undefined,
    canCompress: { available: boolean; reason?: string },
  ): void {
    this.contextUsage = contextUsage;
    this.canCompress = canCompress;
    this.renderData();
    this.updateCompressButtonState();
  }

  private renderData(): void {
    const usage = this.contextUsage;
    const valid = isValidContextUsage(usage);
    const percent = contextUsagePercent(usage);
    const level = contextUsageLevel(usage);

    this.containerEl.dataset.level = level;
    this.percentageEl.textContent = `${Math.round(percent)}%`;

    const offset = (RING_CIRCUMFERENCE * (1 - percent / 100)).toFixed(2);
    this.ringFillEl.style.strokeDashoffset = `${offset}`;
    this.ringFillEl.style.opacity = percent === 0 ? "0" : "1";

    if (valid) {
      this.renderStatValue(this.usedValueEl, formatExactTokens(usage.used));
      this.renderStatValue(this.totalValueEl, formatExactTokens(usage.size));
      this.renderStatValue(
        this.remainingValueEl,
        formatExactTokens(calculateRemainingTokens(usage)),
      );
    } else {
      this.renderStatValue(this.usedValueEl, "0");
      this.renderStatValue(this.totalValueEl, "—", false);
      this.renderStatValue(this.remainingValueEl, "—", false);
    }
  }

  private renderStatValue(
    element: HTMLElement,
    text: string,
    withUnit = true,
  ): void {
    element.textContent = "";
    const textNode = document.createTextNode(text);
    element.appendChild(textNode);
    if (withUnit) {
      const unitSpan = document.createElement("span");
      unitSpan.className = "hermesian-context-popover-unit";
      unitSpan.textContent = " tokens";
      element.appendChild(unitSpan);
    }
  }

  private updateCompressButtonState(): void {
    if (this.canCompress.available) {
      this.compressButtonEl.disabled = false;
      this.compressButtonEl.removeAttribute("aria-disabled");
      this.compressButtonEl.title = "发送 /compress 压缩当前会话上下文";
    } else {
      this.compressButtonEl.disabled = true;
      this.compressButtonEl.setAttribute("aria-disabled", "true");
      this.compressButtonEl.title =
        this.canCompress.reason ?? "当前无法压缩上下文";
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
    const placement = resolveAnchoredDownwardPlacement({
      anchorRect: {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      },
      containerRect,
      viewport,
      popoverWidth: CONTEXT_POPOVER_WIDTH,
      popoverHeightMax: POPOVER_HEIGHT_MAX,
    });
    this.containerEl.style.width = `${placement.width}px`;
    this.containerEl.style.left = `${placement.left}px`;
    this.containerEl.style.top = `${placement.top}px`;
    this.containerEl.style.maxHeight = `${placement.height}px`;
    this.arrowEl.style.left = `${placement.arrowOffsetLeft}px`;
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
