import {
  REASONING_EFFORTS,
  reasoningEffortLabel,
} from "../session-history";
import type { ReasoningEffort } from "../types";

export interface HermesReasoningPickerOptions {
  anchorEl: HTMLElement;
  current: ReasoningEffort;
  efforts?: readonly ReasoningEffort[];
  onChoose: (effort: ReasoningEffort) => void;
  onClose?: () => void;
  getViewport?: () => { height: number; width: number };
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

const POPOVER_WIDTH_MIN = 240;
const POPOVER_WIDTH_MAX = 340;
const POPOVER_HEIGHT_MAX = 420;
const GAP_ABOVE_ANCHOR = 8;
const EDGE_PADDING = 8;
const OPEN_ANIMATION_DELAY_MS = 20;

const EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  default: "Use the selected provider’s default",
  none: "No extra reasoning",
  minimal: "Minimal reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Very deep reasoning",
  max: "Maximum reasoning",
  ultra: "Highest available reasoning",
};

let optionId = 0;

export function reasoningEffortDescription(effort: ReasoningEffort): string {
  return EFFORT_DESCRIPTIONS[effort];
}

/** Upward picker for the composer thinking-depth control. */
export class HermesReasoningPickerPopover {
  private readonly options: HermesReasoningPickerOptions;
  private readonly efforts: readonly ReasoningEffort[];
  private readonly containerEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly iconRenderer: (element: HTMLElement, icon: string) => void;
  private renderedOptions: Array<{ effort: ReasoningEffort; el: HTMLElement }> = [];
  private activeIndex = -1;
  private isOpenFlag = false;
  private settled = false;
  private reducedMotionClassAdded = false;
  private openFrame = 0;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpenFlag) {
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.detach();
        break;
      case "ArrowDown":
        if (this.renderedOptions.length === 0) {
          return;
        }
        event.preventDefault();
        this.setActive(this.activeIndex + 1);
        break;
      case "ArrowUp":
        if (this.renderedOptions.length === 0) {
          return;
        }
        event.preventDefault();
        this.setActive(
          this.activeIndex < 0 ? this.renderedOptions.length - 1 : this.activeIndex - 1,
        );
        break;
      case "Enter":
        if (this.activeIndex < 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.choose(this.renderedOptions[this.activeIndex].effort);
        break;
      default:
        break;
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

  constructor(options: HermesReasoningPickerOptions) {
    this.options = options;
    this.efforts = options.efforts ?? REASONING_EFFORTS;
    this.iconRenderer = options.iconRenderer ?? (() => {});

    this.containerEl = document.createElement("div");
    this.containerEl.className = "hermesian-reasoning-popover";
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-label", "Select Hermes thinking depth");

    const headerEl = document.createElement("div");
    headerEl.className = "hermesian-reasoning-popover-header";

    const titleEl = document.createElement("span");
    titleEl.className = "hermesian-reasoning-popover-title";
    titleEl.textContent = "THINKING DEPTH";

    const closeButtonEl = document.createElement("button");
    closeButtonEl.type = "button";
    closeButtonEl.className =
      "clickable-icon hermesian-reasoning-popover-close-button";
    closeButtonEl.title = "Close";
    closeButtonEl.setAttribute("aria-label", "Close");
    const closeIconEl = document.createElement("span");
    closeButtonEl.appendChild(closeIconEl);
    this.iconRenderer(closeIconEl, "x");
    closeButtonEl.addEventListener("click", () => this.detach());
    headerEl.append(titleEl, closeButtonEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "hermesian-reasoning-popover-body";

    this.listEl = document.createElement("div");
    this.listEl.className = "hermesian-reasoning-popover-list";
    this.listEl.id = `hermesian-reasoning-list-${++optionId}`;
    this.listEl.setAttribute("role", "listbox");
    this.listEl.setAttribute("aria-label", "Thinking depth options");
    this.listEl.tabIndex = -1;

    bodyEl.append(this.listEl);
    this.containerEl.append(headerEl, bodyEl);
    this.containerEl.addEventListener("keydown", this.onKeyDown);
  }

  open(): void {
    if (this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = true;
    this.settled = false;
    document.body.appendChild(this.containerEl);
    this.options.anchorEl.setAttribute("aria-haspopup", "listbox");
    this.options.anchorEl.setAttribute("aria-expanded", "true");
    this.applyReducedMotion(true);
    this.render();
    this.position();
    this.openFrame = window.setTimeout(() => {
      this.containerEl.classList.add("hermesian-reasoning-popover--open");
    }, OPEN_ANIMATION_DELAY_MS);
    this.listEl.focus();
    document.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("resize", this.onResize);
  }

  detach(): void {
    if (!this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = false;
    window.clearTimeout(this.openFrame);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
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

  private choose(effort: ReasoningEffort): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.detach();
    this.options.onChoose(effort);
  }

  private render(): void {
    this.listEl.replaceChildren();
    this.renderedOptions = [];

    const fragment = document.createDocumentFragment();
    for (const effort of this.efforts) {
      const rowEl = document.createElement("div");
      rowEl.className = "hermesian-reasoning-option";
      rowEl.id = `hermesian-reasoning-option-${++optionId}`;
      rowEl.setAttribute("role", "option");
      rowEl.setAttribute("aria-selected", String(effort === this.options.current));

      const copyEl = document.createElement("div");
      copyEl.className = "hermesian-reasoning-option-copy";
      const nameEl = document.createElement("div");
      nameEl.className = "hermesian-reasoning-option-name";
      nameEl.textContent = reasoningEffortLabel(effort);
      const descriptionEl = document.createElement("div");
      descriptionEl.className = "hermesian-reasoning-option-description";
      descriptionEl.textContent = reasoningEffortDescription(effort);
      copyEl.append(nameEl, descriptionEl);
      rowEl.appendChild(copyEl);

      if (effort === this.options.current) {
        const currentEl = document.createElement("span");
        currentEl.className = "hermesian-reasoning-option-current";
        currentEl.textContent = "Current";
        const checkEl = document.createElement("span");
        checkEl.className = "hermesian-reasoning-option-check";
        this.iconRenderer(checkEl, "check");
        rowEl.append(currentEl, checkEl);
      }

      rowEl.addEventListener("pointerenter", () => {
        const index = this.renderedOptions.findIndex((entry) => entry.effort === effort);
        this.setActive(index);
      });
      rowEl.addEventListener("click", () => this.choose(effort));
      this.renderedOptions.push({ effort, el: rowEl });
      fragment.appendChild(rowEl);
    }
    this.listEl.appendChild(fragment);

    const currentIndex = this.renderedOptions.findIndex(
      ({ effort }) => effort === this.options.current,
    );
    this.setActive(currentIndex >= 0 ? currentIndex : 0);
  }

  private setActive(index: number): void {
    if (this.renderedOptions.length === 0 || index < 0) {
      this.activeIndex = -1;
      this.listEl.removeAttribute("aria-activedescendant");
      return;
    }
    this.activeIndex =
      ((index % this.renderedOptions.length) + this.renderedOptions.length) %
      this.renderedOptions.length;
    this.renderedOptions.forEach(({ el }, optionIndex) => {
      el.classList.toggle("is-active", optionIndex === this.activeIndex);
    });
    const activeEl = this.renderedOptions[this.activeIndex].el;
    this.listEl.setAttribute("aria-activedescendant", activeEl.id);
    activeEl.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    const viewport =
      this.options.getViewport?.() ?? {
        height: window.innerHeight,
        width: window.innerWidth,
      };
    const rect = this.options.anchorEl.getBoundingClientRect();
    const width = Math.min(
      POPOVER_WIDTH_MAX,
      Math.max(POPOVER_WIDTH_MIN, Math.round(rect.width)),
      viewport.width - EDGE_PADDING * 2,
    );
    const left = Math.max(
      EDGE_PADDING,
      Math.min(rect.left, viewport.width - width - EDGE_PADDING),
    );
    const maxHeight = Math.min(
      POPOVER_HEIGHT_MAX,
      Math.max(0, rect.top - GAP_ABOVE_ANCHOR - EDGE_PADDING),
    );
    this.containerEl.style.width = `${width}px`;
    this.containerEl.style.left = `${left}px`;
    this.containerEl.style.bottom = `${viewport.height - rect.top + GAP_ABOVE_ANCHOR}px`;
    this.containerEl.style.maxHeight = `${maxHeight}px`;
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
