import type { HermesModelOption, HermesProviderModels } from "../types";
import { resolvePickerPlacement } from "./picker-geometry";

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
 * Normalize a persisted provider expansion state map (`{ [providerId]: boolean }`).
 * Only non-empty provider IDs with boolean values are retained.
 */
export function normalizeProviderExpansionState(
  value: unknown,
): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const trimmed = key.trim();
    if (!trimmed || typeof entry !== "boolean") {
      continue;
    }
    result[trimmed] = entry;
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
  providerExpansion?: Record<string, boolean>;
  onChoose: (model: HermesModelOption) => void;
  onClose?: () => void;
  onSaveHidden: (switchIds: string[]) => void | Promise<void>;
  onSaveProviderExpansion?: (
    expansion: Record<string, boolean>,
  ) => void | Promise<void>;
  getViewport?: () => { height: number; width: number };
  /** Sidebar content box (`.hermesian-view`) in viewport coordinates. */
  getContainerRect?: () => { left: number; width: number };
  /** Renders an icon into an element; Obsidian's setIcon is passed by the host. */
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

const POPOVER_HEIGHT_MAX = 480;
const OPEN_ANIMATION_DELAY_MS = 20;

/**
 * Anchored model picker popover.
 *
 * Renders as a fixed-position panel whose bottom edge sits just above the
 * anchor button, so it always grows upward from the composer. Supports a
 * select mode (search + collapsible provider groups) and a manage mode
 * (search + collapsible provider groups + per-provider All/None + per-model
 * visibility checkboxes). All persistence goes through `onSaveHidden` and
 * `onSaveProviderExpansion`; the popover keeps its own normalized copy of the
 * hidden ids so toggles never depend on stale caller state.
 */
export class HermesModelPickerPopover {
  private readonly options: HermesModelPickerOptions;
  private readonly containerEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly searchInputEl: HTMLInputElement;
  private readonly manageSearchInputEl: HTMLInputElement;
  private readonly manageSummaryEl: HTMLElement;
  private readonly backButtonEl: HTMLButtonElement;
  private readonly selectListEl: HTMLElement;
  private readonly manageListEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly emptyCopyEl: HTMLElement;
  private readonly iconRenderer: (element: HTMLElement, icon: string) => void;

  private hiddenSwitchIds: string[];
  private providerExpansion: Record<string, boolean>;
  private readonly selectSessionToggles = new Map<string, boolean>();
  private readonly manageSessionToggles = new Map<string, boolean>();
  private mode: "select" | "manage" = "select";
  private query = "";
  private manageQuery = "";
  private activeIndex = -1;
  private savingHidden = false;
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

  private readonly onManageSearchInput = (): void => {
    this.manageQuery = this.manageSearchInputEl.value;
    this.renderManage();
  };

  constructor(options: HermesModelPickerOptions) {
    this.options = options;
    this.iconRenderer = options.iconRenderer ?? (() => {});
    this.hiddenSwitchIds = normalizeHiddenSwitchIds(options.hiddenSwitchIds);
    this.providerExpansion = normalizeProviderExpansionState(
      options.providerExpansion,
    );

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
    manageButtonEl.title = "Manage visible models";
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

    const manageTopRowEl = document.createElement("div");
    manageTopRowEl.className = "hermesian-model-popover-manage-top";

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

    this.manageSummaryEl = document.createElement("span");
    this.manageSummaryEl.className = "hermesian-model-popover-manage-summary";

    manageTopRowEl.append(this.backButtonEl, manageTitleEl, this.manageSummaryEl);

    this.manageSearchInputEl = document.createElement("input");
    this.manageSearchInputEl.className = "hermesian-model-popover-search hermesian-model-popover-manage-search";
    this.manageSearchInputEl.type = "text";
    this.manageSearchInputEl.placeholder = "Filter provider or model ID…";
    this.manageSearchInputEl.setAttribute("aria-label", "Filter models in manage mode");
    this.manageSearchInputEl.addEventListener("input", this.onManageSearchInput);

    manageHeaderEl.append(manageTopRowEl, this.manageSearchInputEl);

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

  private setManageCheckboxesDisabled(disabled: boolean): void {
    for (const checkbox of this.manageListEl.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    )) {
      checkbox.disabled = disabled;
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

  private isGroupExpandedInSelect(
    group: HermesProviderModels,
    totalGroups: number,
  ): boolean {
    if (this.query.trim()) {
      return true;
    }
    if (this.selectSessionToggles.has(group.id)) {
      return this.selectSessionToggles.get(group.id)!;
    }
    if (
      this.options.currentSwitchId &&
      group.models.some((model) => model.switchId === this.options.currentSwitchId)
    ) {
      return true;
    }
    if (this.providerExpansion[group.id] !== undefined) {
      return this.providerExpansion[group.id];
    }
    if (totalGroups <= 1) {
      return true;
    }
    return false;
  }

  private isGroupExpandedInManage(
    group: HermesProviderModels,
    totalGroups: number,
  ): boolean {
    if (this.manageQuery.trim()) {
      return true;
    }
    if (this.manageSessionToggles.has(group.id)) {
      return this.manageSessionToggles.get(group.id)!;
    }
    if (
      this.options.currentSwitchId &&
      group.models.some((model) => model.switchId === this.options.currentSwitchId)
    ) {
      return true;
    }
    if (totalGroups <= 1) {
      return true;
    }
    return false;
  }

  private toggleSelectProvider(providerId: string, nextExpanded: boolean): void {
    this.selectSessionToggles.set(providerId, nextExpanded);
    this.providerExpansion = {
      ...this.providerExpansion,
      [providerId]: nextExpanded,
    };
    void Promise.resolve(
      this.options.onSaveProviderExpansion?.({ ...this.providerExpansion }),
    ).catch(() => {});
    this.renderSelect();
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
    const groups = groupModelsByProvider(visible);
    for (const group of groups) {
      const isExpanded = this.isGroupExpandedInSelect(group, groups.length);
      const groupEl = document.createElement("div");
      groupEl.className = isExpanded
        ? "hermesian-model-group"
        : "hermesian-model-group is-collapsed";
      groupEl.dataset.providerId = group.id;

      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "hermesian-model-group-header";
      headerBtn.setAttribute("aria-expanded", String(isExpanded));

      const chevronEl = document.createElement("span");
      chevronEl.className = "hermesian-model-group-chevron";
      chevronEl.setAttribute("aria-hidden", "true");
      this.iconRenderer(chevronEl, isExpanded ? "chevron-down" : "chevron-right");

      const labelEl = document.createElement("span");
      labelEl.className = "hermesian-model-group-label";
      labelEl.textContent = group.label;

      const countEl = document.createElement("span");
      countEl.className = "hermesian-model-group-count";
      countEl.textContent = String(group.models.length);

      headerBtn.append(chevronEl, labelEl, countEl);
      headerBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleSelectProvider(group.id, !isExpanded);
      });
      groupEl.appendChild(headerBtn);

      const itemsEl = document.createElement("div");
      itemsEl.className = "hermesian-model-group-items";

      for (const model of group.models) {
        const optionEl = document.createElement("div");
        optionEl.className = "hermesian-model-option";
        optionEl.setAttribute("role", "option");
        optionEl.tabIndex = -1;
        optionEl.title = model.description
          ? `${model.providerName} · ${model.modelId} — ${model.description}`
          : `${model.providerName} · ${model.modelId}`;

        const copyEl = document.createElement("div");
        copyEl.className = "hermesian-model-option-copy";
        const nameEl = document.createElement("div");
        nameEl.className = "hermesian-model-option-name";
        nameEl.textContent = model.name;
        copyEl.appendChild(nameEl);
        if (model.description) {
          const descEl = document.createElement("div");
          descEl.className = "hermesian-model-option-desc";
          descEl.textContent = model.description;
          copyEl.appendChild(descEl);
        }
        optionEl.appendChild(copyEl);
        if (model.switchId === this.options.currentSwitchId) {
          optionEl.classList.add("is-selected");
          optionEl.setAttribute("aria-selected", "true");
          const checkEl = document.createElement("span");
          checkEl.className = "hermesian-model-option-check";
          checkEl.setAttribute("aria-hidden", "true");
          this.iconRenderer(checkEl, "check");
          optionEl.appendChild(checkEl);
        }
        optionEl.addEventListener("click", () => {
          this.choose(model);
        });
        if (isExpanded) {
          const index = this.renderedOptions.length;
          optionEl.addEventListener("mouseenter", () => {
            this.setActive(index);
          });
          optionEl.addEventListener("mousemove", () => {
            this.setActive(index);
          });
          this.renderedOptions.push({ el: optionEl, model });
        }
        itemsEl.appendChild(optionEl);
      }
      groupEl.appendChild(itemsEl);
      fragment.appendChild(groupEl);
    }
    this.selectListEl.appendChild(fragment);
  }

  private syncManageDomState(): void {
    const hiddenSet = new Set(this.hiddenSwitchIds);
    const totalModels = this.options.models.length;
    const visibleModelsCount = this.options.models.filter(
      (model) => !hiddenSet.has(model.switchId),
    ).length;
    this.manageSummaryEl.textContent = `${visibleModelsCount} / ${totalModels}`;

    for (const checkbox of this.manageListEl.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    )) {
      checkbox.checked = !hiddenSet.has(checkbox.value);
      checkbox.disabled = this.savingHidden;
    }

    const fullGroupsById = new Map(
      groupModelsByProvider(this.options.models).map((g) => [g.id, g]),
    );
    const filteredGroupsById = new Map(
      groupModelsByProvider(
        searchModels(this.options.models, this.manageQuery),
      ).map((g) => [g.id, g]),
    );

    for (const groupEl of this.manageListEl.querySelectorAll<HTMLElement>(
      ".hermesian-model-manage-group",
    )) {
      const providerId = groupEl.dataset.providerId ?? "";
      const fullGroup = fullGroupsById.get(providerId);
      const filteredGroup = filteredGroupsById.get(providerId) ?? fullGroup;
      if (!fullGroup || !filteredGroup) {
        continue;
      }
      const enabledCount = fullGroup.models.filter(
        (m) => !hiddenSet.has(m.switchId),
      ).length;
      const countEl = groupEl.querySelector<HTMLElement>(
        ".hermesian-model-group-count",
      );
      if (countEl) {
        countEl.textContent = `${enabledCount}/${fullGroup.models.length}`;
        countEl.classList.toggle("is-zero", enabledCount === 0);
      }
      const allBtn = groupEl.querySelector<HTMLButtonElement>(
        "[data-bulk-action='all']",
      );
      if (allBtn) {
        allBtn.disabled =
          this.savingHidden ||
          filteredGroup.models.every((m) => !hiddenSet.has(m.switchId));
      }
      const noneBtn = groupEl.querySelector<HTMLButtonElement>(
        "[data-bulk-action='none']",
      );
      if (noneBtn) {
        noneBtn.disabled =
          this.savingHidden ||
          filteredGroup.models.every((m) => hiddenSet.has(m.switchId));
      }
    }
  }

  private async persistHiddenList(next: string[]): Promise<boolean> {
    if (this.savingHidden) {
      this.syncManageDomState();
      return false;
    }
    this.savingHidden = true;
    this.setManageCheckboxesDisabled(true);
    try {
      await this.options.onSaveHidden(next);
      this.hiddenSwitchIds = next;
      return true;
    } catch {
      return false;
    } finally {
      this.savingHidden = false;
      this.syncManageDomState();
    }
  }

  private async setProviderModelsVisibility(
    models: HermesModelOption[],
    visible: boolean,
  ): Promise<void> {
    const hidden = new Set(this.hiddenSwitchIds);
    for (const model of models) {
      if (visible) {
        hidden.delete(model.switchId);
      } else {
        hidden.add(model.switchId);
      }
    }
    await this.persistHiddenList([...hidden]);
  }

  private renderManage(): void {
    this.manageListEl.replaceChildren();
    const hiddenSet = new Set(this.hiddenSwitchIds);
    const totalModels = this.options.models.length;
    const visibleModelsCount = this.options.models.filter(
      (model) => !hiddenSet.has(model.switchId),
    ).length;
    this.manageSummaryEl.textContent = `${visibleModelsCount} / ${totalModels}`;

    const fullGroupsById = new Map(
      groupModelsByProvider(this.options.models).map((g) => [g.id, g]),
    );
    const filteredModels = searchModels(this.options.models, this.manageQuery);
    const groups = groupModelsByProvider(filteredModels);

    if (groups.length === 0) {
      const emptyManageEl = document.createElement("div");
      emptyManageEl.className = "hermesian-model-popover-empty";
      emptyManageEl.textContent = "No models match your filter.";
      this.manageListEl.appendChild(emptyManageEl);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      const fullGroup = fullGroupsById.get(group.id) ?? group;
      const enabledCount = fullGroup.models.filter(
        (m) => !hiddenSet.has(m.switchId),
      ).length;
      const isExpanded = this.isGroupExpandedInManage(group, groups.length);

      const groupEl = document.createElement("div");
      groupEl.className = isExpanded
        ? "hermesian-model-group hermesian-model-manage-group"
        : "hermesian-model-group hermesian-model-manage-group is-collapsed";
      groupEl.dataset.providerId = group.id;

      const headerRowEl = document.createElement("div");
      headerRowEl.className = "hermesian-model-manage-group-header";

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "hermesian-model-group-toggle";
      toggleBtn.setAttribute("aria-expanded", String(isExpanded));

      const chevronEl = document.createElement("span");
      chevronEl.className = "hermesian-model-group-chevron";
      chevronEl.setAttribute("aria-hidden", "true");
      this.iconRenderer(chevronEl, isExpanded ? "chevron-down" : "chevron-right");

      const labelEl = document.createElement("span");
      labelEl.className = "hermesian-model-group-label";
      labelEl.textContent = group.label;

      const countEl = document.createElement("span");
      countEl.className = "hermesian-model-group-count";
      if (enabledCount === 0) {
        countEl.classList.add("is-zero");
      }
      countEl.textContent = `${enabledCount}/${fullGroup.models.length}`;

      toggleBtn.append(chevronEl, labelEl, countEl);
      toggleBtn.addEventListener("click", () => {
        this.manageSessionToggles.set(group.id, !isExpanded);
        this.renderManage();
      });

      const actionsEl = document.createElement("div");
      actionsEl.className = "hermesian-model-manage-group-actions";

      const allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "hermesian-model-manage-bulk-btn";
      allBtn.dataset.bulkAction = "all";
      allBtn.textContent = "All";
      allBtn.title = `Show all models in ${group.label}`;
      allBtn.disabled =
        this.savingHidden || group.models.every((m) => !hiddenSet.has(m.switchId));
      allBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.setProviderModelsVisibility(group.models, true);
      });

      const noneBtn = document.createElement("button");
      noneBtn.type = "button";
      noneBtn.className = "hermesian-model-manage-bulk-btn";
      noneBtn.dataset.bulkAction = "none";
      noneBtn.textContent = "None";
      noneBtn.title = `Hide all models in ${group.label}`;
      noneBtn.disabled =
        this.savingHidden || group.models.every((m) => hiddenSet.has(m.switchId));
      noneBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.setProviderModelsVisibility(group.models, false);
      });

      actionsEl.append(allBtn, noneBtn);
      headerRowEl.append(toggleBtn, actionsEl);
      groupEl.appendChild(headerRowEl);

      const itemsEl = document.createElement("div");
      itemsEl.className = "hermesian-model-group-items";

      for (const model of group.models) {
        const rowEl = document.createElement("label");
        rowEl.className = "hermesian-model-manage-row";
        rowEl.title = model.description
          ? `${model.providerName} · ${model.modelId} — ${model.description}`
          : `${model.providerName} · ${model.modelId}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = model.switchId;
        checkbox.checked = !hiddenSet.has(model.switchId);
        checkbox.disabled = this.savingHidden;
        checkbox.setAttribute("aria-label", `Show ${model.name}`);
        checkbox.addEventListener("change", async () => {
          if (this.savingHidden) {
            checkbox.checked = !checkbox.checked;
            return;
          }
          const hidden = new Set(this.hiddenSwitchIds);
          if (checkbox.checked) {
            hidden.delete(model.switchId);
          } else {
            hidden.add(model.switchId);
          }
          await this.persistHiddenList([...hidden]);
        });
        const copyEl = document.createElement("div");
        copyEl.className = "hermesian-model-manage-copy";
        const nameEl = document.createElement("div");
        nameEl.className = "hermesian-model-manage-name";
        nameEl.textContent = model.name;
        copyEl.appendChild(nameEl);
        if (model.description) {
          const descEl = document.createElement("div");
          descEl.className = "hermesian-model-manage-desc";
          descEl.textContent = model.description;
          copyEl.appendChild(descEl);
        }
        rowEl.append(checkbox, copyEl);
        itemsEl.appendChild(rowEl);
      }
      groupEl.appendChild(itemsEl);
      fragment.appendChild(groupEl);
    }
    this.manageListEl.appendChild(fragment);
  }

  private position(): void {
    const viewport =
      this.options.getViewport?.() ?? { height: window.innerHeight, width: window.innerWidth };
    // Without a host-provided sidebar rect, fall back to "the whole window is
    // the container" so the popover still positions sensibly outside Obsidian.
    const containerRect = this.options.getContainerRect?.() ?? {
      left: 0,
      width: viewport.width,
    };
    const rect = this.options.anchorEl.getBoundingClientRect();
    // Shared geometry: one width/left/height resolution for both composer
    // pickers. The width follows the sidebar, never the anchor button, so the
    // panel never spills past the sidebar edge. Never
    // exceed the space between the anchor and the viewport top, so the panel top
    // stays inside the viewport even when the button sits near the top edge;
    // there is intentionally no minimum height floor.
    const placement = resolvePickerPlacement({
      anchorRect: { top: rect.top },
      containerRect,
      viewport,
      popoverHeightMax: POPOVER_HEIGHT_MAX,
    });
    this.containerEl.style.width = `${placement.width}px`;
    this.containerEl.style.left = `${placement.left}px`;
    this.containerEl.style.bottom = `${placement.bottom}px`;
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
