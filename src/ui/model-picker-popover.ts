import type { HermesModelOption, HermesProviderModels } from "../types";

/**
 * Normalize a persisted "hidden model switch ids" value.
 *
 * Only non-empty trimmed strings are kept, duplicates are removed and
 * first-occurrence order is preserved. Anything missing, malformed or from an
 * older data shape safely falls back to an empty array.
 */
export function normalizeHiddenSwitchIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Models that should appear in the picker's select list: everything that is
 * not hidden, plus the current model even when it is hidden so the UI never
 * contradicts the active session state. Catalog order is preserved.
 */
export function filterVisibleModels(
  models: HermesModelOption[],
  hiddenSwitchIds: string[],
  currentSwitchId: string | undefined,
): HermesModelOption[] {
  const hidden = new Set(normalizeHiddenSwitchIds(hiddenSwitchIds));
  return models.filter(
    (model) => !hidden.has(model.switchId) || model.switchId === currentSwitchId,
  );
}

/**
 * Group models by provider preserving first-occurrence order of providers and
 * models within each provider (the catalog order).
 */
export function groupModelsByProvider(models: HermesModelOption[]): HermesProviderModels[] {
  const groups: HermesProviderModels[] = [];
  const byProviderId = new Map<string, HermesProviderModels>();
  for (const model of models) {
    let group = byProviderId.get(model.providerId);
    if (!group) {
      group = { id: model.providerId, label: model.providerName, models: [] };
      byProviderId.set(model.providerId, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/**
 * Case-insensitive search over provider name/id, model name/id and description.
 * An empty or whitespace-only query returns the input unchanged.
 */
export function searchModels(
  models: HermesModelOption[],
  query: string,
): HermesModelOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }
  return models.filter((model) =>
    [
      model.providerName,
      model.providerId,
      model.name,
      model.modelId,
      model.description,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}

export interface HermesModelPickerOptions {
  anchorEl: HTMLElement;
  currentSwitchId?: string;
  hiddenSwitchIds: string[];
  models: HermesModelOption[];
  onChoose: (model: HermesModelOption) => void;
  onClose?: () => void;
  onSaveHidden: (switchIds: string[]) => void;
  getViewport?: () => { height: number; width: number };
  /** Renders an icon into an element; Obsidian's setIcon is passed by the host. */
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

const POPOVER_WIDTH_MIN = 240;
const POPOVER_WIDTH_MAX = 420;
const POPOVER_HEIGHT_MIN = 120;
const POPOVER_HEIGHT_MAX = 480;
const GAP_ABOVE_ANCHOR = 8;
const EDGE_PADDING = 8;
const OPEN_ANIMATION_DELAY_MS = 20;

/**
 * Anchored model picker popover.
 *
 * Renders as a fixed-position panel whose bottom edge sits just above the
 * anchor button, so it always grows upward from the composer. Supports a
 * select mode (search + provider groups) and a manage mode (per-model
 * visibility checkboxes). All persistence goes through `onSaveHidden`; the
 * popover keeps its own normalized copy of the hidden ids so toggles never
 * depend on stale caller state.
 */
export class HermesModelPickerPopover {
  private readonly options: HermesModelPickerOptions;
  private readonly containerEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly searchInputEl: HTMLInputElement;
  private readonly backButtonEl: HTMLButtonElement;
  private readonly selectListEl: HTMLElement;
  private readonly manageListEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly emptyCopyEl: HTMLElement;
  private readonly iconRenderer: (element: HTMLElement, icon: string) => void;

  private hiddenSwitchIds: string[];
  private mode: "select" | "manage" = "select";
  private query = "";
  private activeIndex = -1;
  private renderedOptions: Array<{ el: HTMLElement; model: HermesModelOption }> = [];
  private isOpenFlag = false;
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
        if (this.mode !== "select" || this.renderedOptions.length === 0) {
          break;
        }
        event.preventDefault();
        this.setActive(this.activeIndex + 1);
        break;
      case "ArrowUp":
        if (this.mode !== "select" || this.renderedOptions.length === 0) {
          break;
        }
        event.preventDefault();
        this.setActive(
          this.activeIndex < 0 ? this.renderedOptions.length - 1 : this.activeIndex - 1,
        );
        break;
      case "Enter":
        if (this.mode !== "select" || this.activeIndex < 0) {
          break;
        }
        event.preventDefault();
        event.stopPropagation();
        this.choose(this.renderedOptions[this.activeIndex].model);
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
    if (!target) {
      return;
    }
    if (this.containerEl.contains(target) || this.options.anchorEl.contains(target)) {
      return;
    }
    this.detach();
  };

  private readonly onResize = (): void => {
    this.position();
  };

  private readonly onSearchInput = (): void => {
    this.query = this.searchInputEl.value;
    this.renderSelect();
  };

  constructor(options: HermesModelPickerOptions) {
    this.options = options;
    this.iconRenderer = options.iconRenderer ?? (() => {});
    this.hiddenSwitchIds = normalizeHiddenSwitchIds(options.hiddenSwitchIds);

    this.containerEl = document.createElement("div");
    this.containerEl.className = "hermesian-model-popover";
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-label", "Select Hermes model");

    const headerEl = document.createElement("div");
    headerEl.className = "hermesian-model-popover-header";

    this.searchInputEl = document.createElement("input");
    this.searchInputEl.className = "hermesian-model-popover-search";
    this.searchInputEl.type = "text";
    this.searchInputEl.placeholder = "Search provider or model…";
    this.searchInputEl.setAttribute("aria-label", "Search models");
    this.searchInputEl.addEventListener("input", this.onSearchInput);

    const manageButtonEl = document.createElement("button");
    manageButtonEl.type = "button";
    manageButtonEl.className = "clickable-icon hermesian-model-popover-manage-button";
    manageButtonEl.title = "Manage models";
    manageButtonEl.setAttribute("aria-label", "Manage models");
    const manageIconEl = document.createElement("span");
    manageButtonEl.appendChild(manageIconEl);
    this.iconRenderer(manageIconEl, "sliders-horizontal");
    manageButtonEl.addEventListener("click", () => this.setMode("manage"));

    const closeButtonEl = document.createElement("button");
    closeButtonEl.type = "button";
    closeButtonEl.className = "clickable-icon hermesian-model-popover-close-button";
    closeButtonEl.title = "Close";
    closeButtonEl.setAttribute("aria-label", "Close");
    const closeIconEl = document.createElement("span");
    closeButtonEl.appendChild(closeIconEl);
    this.iconRenderer(closeIconEl, "x");
    closeButtonEl.addEventListener("click", () => this.detach());

    headerEl.append(this.searchInputEl, manageButtonEl, closeButtonEl);

    const manageHeaderEl = document.createElement("div");
    manageHeaderEl.className = "hermesian-model-popover-manage-header";
    this.backButtonEl = document.createElement("button");
    this.backButtonEl.type = "button";
    this.backButtonEl.className = "clickable-icon hermesian-model-popover-back-button";
    this.backButtonEl.title = "Back to model list";
    this.backButtonEl.setAttribute("aria-label", "Back to model list");
    const backIconEl = document.createElement("span");
    this.backButtonEl.appendChild(backIconEl);
    this.iconRenderer(backIconEl, "chevron-left");
    this.backButtonEl.addEventListener("click", () => this.setMode("select"));
    const manageTitleEl = document.createElement("span");
    manageTitleEl.className = "hermesian-model-popover-manage-title";
    manageTitleEl.textContent = "Manage models";
    manageHeaderEl.append(this.backButtonEl, manageTitleEl);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "hermesian-model-popover-body";

    this.selectListEl = document.createElement("div");
    this.selectListEl.className = "hermesian-model-popover-list";
    this.selectListEl.setAttribute("role", "listbox");
    this.selectListEl.setAttribute("aria-label", "Available models");

    this.manageListEl = document.createElement("div");
    this.manageListEl.className = "hermesian-model-popover-manage-list";

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "hermesian-model-popover-empty";
    this.emptyCopyEl = document.createElement("div");
    this.emptyCopyEl.className = "hermesian-model-popover-empty-copy";
    const emptyActionEl = document.createElement("button");
    emptyActionEl.type = "button";
    emptyActionEl.className = "hermesian-model-popover-empty-action";
    emptyActionEl.textContent = "Manage models";
    emptyActionEl.addEventListener("click", () => this.setMode("manage"));
    this.emptyEl.append(this.emptyCopyEl, emptyActionEl);

    this.bodyEl.append(this.selectListEl, this.manageListEl, this.emptyEl);
    this.containerEl.append(headerEl, manageHeaderEl, this.bodyEl);
    this.containerEl.addEventListener("keydown", this.onKeyDown);
  }

  open(): void {
    if (this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = true;
    document.body.appendChild(this.containerEl);
    this.options.anchorEl.setAttribute("aria-haspopup", "listbox");
    this.options.anchorEl.setAttribute("aria-expanded", "true");
    this.applyReducedMotion(true);
    this.renderSelect();
    this.position();
    this.openFrame = window.setTimeout(() => {
      this.containerEl.classList.add("hermesian-model-popover--open");
    }, OPEN_ANIMATION_DELAY_MS);
    this.searchInputEl.focus();
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
    this.options.onClose?.();
  }

  isOpen(): boolean {
    return this.isOpenFlag;
  }

  private setMode(mode: "select" | "manage"): void {
    this.mode = mode;
    this.containerEl.classList.toggle("is-manage", mode === "manage");
    if (mode === "manage") {
      this.renderManage();
      this.backButtonEl.focus();
    } else {
      this.renderSelect();
      this.searchInputEl.focus();
    }
  }

  private choose(model: HermesModelOption): void {
    this.options.onChoose(model);
    this.detach();
  }

  private setActive(index: number): void {
    if (this.mode !== "select" || this.renderedOptions.length === 0) {
      return;
    }
    this.activeIndex =
      ((index % this.renderedOptions.length) + this.renderedOptions.length) %
      this.renderedOptions.length;
    this.renderedOptions.forEach(({ el }, i) => {
      el.classList.toggle("is-active", i === this.activeIndex);
      if (i === this.activeIndex) {
        el.scrollIntoView?.({ block: "nearest" });
      }
    });
  }

  private renderSelect(): void {
    this.selectListEl.replaceChildren();
    this.activeIndex = -1;
    this.renderedOptions = [];
    const visible = searchModels(
      filterVisibleModels(
        this.options.models,
        this.hiddenSwitchIds,
        this.options.currentSwitchId,
      ),
      this.query,
    );
    if (visible.length === 0) {
      this.emptyCopyEl.textContent = this.query.trim()
        ? "No models match your search."
        : "All models are hidden.";
      this.emptyEl.style.display = "";
      return;
    }
    this.emptyEl.style.display = "none";
    const fragment = document.createDocumentFragment();
    for (const group of groupModelsByProvider(visible)) {
      const groupEl = document.createElement("div");
      groupEl.className = "hermesian-model-group";
      const labelEl = document.createElement("div");
      labelEl.className = "hermesian-model-group-label";
      labelEl.textContent = group.label;
      groupEl.appendChild(labelEl);
      for (const model of group.models) {
        const optionEl = document.createElement("div");
        optionEl.className = "hermesian-model-option";
        optionEl.setAttribute("role", "option");
        optionEl.tabIndex = -1;
        const copyEl = document.createElement("div");
        copyEl.className = "hermesian-model-option-copy";
        const nameEl = document.createElement("div");
        nameEl.className = "hermesian-model-option-name";
        nameEl.textContent = model.name;
        const providerEl = document.createElement("div");
        providerEl.className = "hermesian-model-option-provider";
        providerEl.textContent = model.description
          ? `${model.providerName} · ${model.description}`
          : model.providerName;
        copyEl.append(nameEl, providerEl);
        optionEl.appendChild(copyEl);
        if (model.switchId === this.options.currentSwitchId) {
          optionEl.setAttribute("aria-selected", "true");
          const checkEl = document.createElement("span");
          checkEl.className = "hermesian-model-option-check";
          checkEl.setAttribute("aria-hidden", "true");
          this.iconRenderer(checkEl, "check");
          optionEl.appendChild(checkEl);
          const badgeEl = document.createElement("span");
          badgeEl.className = "hermesian-model-option-current";
          badgeEl.textContent = "Current";
          optionEl.appendChild(badgeEl);
        }
        const index = this.renderedOptions.length;
        optionEl.addEventListener("click", () => {
          this.choose(model);
        });
        optionEl.addEventListener("mouseenter", () => {
          this.setActive(index);
        });
        optionEl.addEventListener("mousemove", () => {
          this.setActive(index);
        });
        this.renderedOptions.push({ el: optionEl, model });
        groupEl.appendChild(optionEl);
      }
      fragment.appendChild(groupEl);
    }
    this.selectListEl.appendChild(fragment);
  }

  private renderManage(): void {
    this.manageListEl.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const group of groupModelsByProvider(this.options.models)) {
      const groupEl = document.createElement("div");
      groupEl.className = "hermesian-model-group";
      const labelEl = document.createElement("div");
      labelEl.className = "hermesian-model-group-label";
      labelEl.textContent = group.label;
      groupEl.appendChild(labelEl);
      for (const model of group.models) {
        const rowEl = document.createElement("label");
        rowEl.className = "hermesian-model-manage-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = model.switchId;
        checkbox.checked = !this.hiddenSwitchIds.includes(model.switchId);
        checkbox.setAttribute("aria-label", `Show ${model.name}`);
        checkbox.addEventListener("change", () => {
          const hidden = new Set(this.hiddenSwitchIds);
          if (checkbox.checked) {
            hidden.delete(model.switchId);
          } else {
            hidden.add(model.switchId);
          }
          this.hiddenSwitchIds = [...hidden];
          this.options.onSaveHidden(this.hiddenSwitchIds);
        });
        const copyEl = document.createElement("div");
        copyEl.className = "hermesian-model-manage-copy";
        const nameEl = document.createElement("div");
        nameEl.className = "hermesian-model-manage-name";
        nameEl.textContent = model.name;
        const providerEl = document.createElement("div");
        providerEl.className = "hermesian-model-manage-provider";
        providerEl.textContent = model.description
          ? `${model.providerName} · ${model.description}`
          : model.providerName;
        copyEl.append(nameEl, providerEl);
        rowEl.append(checkbox, copyEl);
        groupEl.appendChild(rowEl);
      }
      fragment.appendChild(groupEl);
    }
    this.manageListEl.appendChild(fragment);
  }

  private position(): void {
    const viewport =
      this.options.getViewport?.() ?? { height: window.innerHeight, width: window.innerWidth };
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
    const spaceAbove = rect.top - GAP_ABOVE_ANCHOR;
    const maxHeight = Math.min(
      POPOVER_HEIGHT_MAX,
      Math.max(POPOVER_HEIGHT_MIN, spaceAbove),
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
