import type {
  HermesModelOption,
  HermesProviderModels,
  ReasoningEffort,
} from "../types";
import {
  filterVisibleModels,
  groupModelsByProvider,
  normalizeProviderExpansionState,
  searchModels,
} from "./model-picker-popover";
import { resolveDownwardPickerPlacement } from "./picker-geometry";

export interface HermesTitlePopoverOptions {
  anchorEl: HTMLElement;
  tabId: string;
  tabLabel: number;
  currentTitle: string;
  hasCustomTitle: boolean;
  canGenerateAi: boolean;
  models?: HermesModelOption[];
  catalogLoading?: boolean;
  hiddenModelSwitchIds?: string[];
  providerExpansion?: Record<string, boolean>;
  selectedAiModel?: HermesModelOption;
  selectedAiReasoningEffort?: ReasoningEffort;
  onSelectAiModel?: (model: HermesModelOption | undefined) => void | Promise<void>;
  onSelectAiReasoning?: (effort: ReasoningEffort) => void | Promise<void>;
  onSaveProviderExpansion?: (
    expansion: Record<string, boolean>,
  ) => void | Promise<void>;
  onRename: (nextTitle: string) => Promise<string>;
  onGenerateAi: () => Promise<string>;
  onClose?: () => void;
  getViewport?: () => { height: number; width: number };
  getContainerRect?: () => { left: number; width: number };
  iconRenderer?: (element: HTMLElement, icon: string) => void;
}

const POPOVER_HEIGHT_MAX = 320;
const PICKER_POPOVER_HEIGHT_MAX = 420;
const OPEN_ANIMATION_DELAY_MS = 20;

const TITLE_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "default",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const TITLE_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: "关闭思考（默认，最快）",
  default: "跟随所选模型/提供商默认设置",
  minimal: "极简思考",
  low: "轻度思考",
  medium: "适度思考",
  high: "深度思考",
  xhigh: "极深思考",
  max: "最大思考",
  ultra: "最高可用思考",
};

function titleEffortCapsuleLabel(effort: ReasoningEffort): string {
  return effort === "default" ? "默认" : effort;
}

function titleEffortOptionLabel(effort: ReasoningEffort): string {
  if (effort === "none") {
    return "none (关闭思考)";
  }
  if (effort === "default") {
    return "Provider default";
  }
  return effort;
}

export class HermesTitlePopover {
  private readonly options: HermesTitlePopoverOptions;
  private currentTitle: string;
  private hasCustomTitle: boolean;
  private canGenerateAi: boolean;
  private models: HermesModelOption[];
  private catalogLoading: boolean;
  private hiddenModelSwitchIds: string[];
  private providerExpansion: Record<string, boolean>;
  private readonly sessionProviderToggles = new Map<string, boolean>();
  private selectedAiModel: HermesModelOption | undefined;
  private selectedAiReasoningEffort: ReasoningEffort;

  private isOpenFlag = false;
  private isEditing = false;
  private isBusy = false;
  private mode: "main" | "model" | "reasoning" = "main";
  private modelQuery = "";
  private activePickerIndex = -1;
  private renderedPickerActions: Array<{ el: HTMLElement; onChoose: () => void }> = [];
  private openFrame = 0;
  private reducedMotionClassAdded = false;

  private readonly containerEl: HTMLElement;
  private readonly mainBodyEl: HTMLElement;
  private readonly displayEl: HTMLElement;
  private readonly titleTriggerEl: HTMLButtonElement;
  private readonly titleTextEl: HTMLElement;
  private readonly editButtonEl: HTMLButtonElement;
  private readonly inputEl: HTMLInputElement;
  private readonly aiButtonEl: HTMLButtonElement;
  private readonly aiModelButtonEl: HTMLButtonElement;
  private readonly aiModelLabelEl: HTMLElement;
  private readonly aiReasoningButtonEl: HTMLButtonElement;
  private readonly aiReasoningLabelEl: HTMLElement;
  private readonly errorEl: HTMLElement;

  private readonly pickerPaneEl: HTMLElement;
  private readonly pickerBackButtonEl: HTMLButtonElement;
  private readonly pickerTitleEl: HTMLElement;
  private readonly pickerSearchEl: HTMLInputElement;
  private readonly pickerListEl: HTMLElement;

  private readonly iconRenderer: (element: HTMLElement, icon: string) => void;

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpenFlag) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.mode !== "main") {
        this.exitSubPickerMode();
      } else if (this.isEditing) {
        this.exitEditMode();
      } else {
        this.detach();
      }
    }
  };

  private readonly onContainerKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpenFlag || this.mode === "main") {
      return;
    }
    if (event.key === "ArrowDown") {
      if (this.renderedPickerActions.length === 0) {
        return;
      }
      event.preventDefault();
      this.setActivePickerIndex(this.activePickerIndex + 1);
    } else if (event.key === "ArrowUp") {
      if (this.renderedPickerActions.length === 0) {
        return;
      }
      event.preventDefault();
      this.setActivePickerIndex(
        this.activePickerIndex < 0
          ? this.renderedPickerActions.length - 1
          : this.activePickerIndex - 1,
      );
    } else if (event.key === "Enter" && !event.isComposing) {
      if (this.activePickerIndex < 0 || this.activePickerIndex >= this.renderedPickerActions.length) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.renderedPickerActions[this.activePickerIndex].onChoose();
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
    this.models = options.models ? [...options.models] : [];
    this.catalogLoading = Boolean(options.catalogLoading);
    this.hiddenModelSwitchIds = options.hiddenModelSwitchIds
      ? [...options.hiddenModelSwitchIds]
      : [];
    this.providerExpansion = normalizeProviderExpansionState(
      options.providerExpansion,
    );
    this.selectedAiModel = options.selectedAiModel;
    this.selectedAiReasoningEffort = options.selectedAiReasoningEffort ?? "none";
    this.iconRenderer = options.iconRenderer ?? (() => {});

    this.containerEl = document.createElement("div");
    this.containerEl.className = "hermesian-title-popover";
    this.containerEl.tabIndex = -1;
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-label", "Conversation title");
    this.containerEl.addEventListener("keydown", this.onContainerKeyDown);

    // Header (no close button inside popover per Q1)
    const headerEl = document.createElement("div");
    headerEl.className = "hermesian-title-popover-header";

    const headingEl = document.createElement("div");
    headingEl.className = "hermesian-title-popover-heading";
    headingEl.textContent = `CONVERSATION ${options.tabLabel}`;
    headerEl.appendChild(headingEl);

    // Main body
    this.mainBodyEl = document.createElement("div");
    this.mainBodyEl.className = "hermesian-title-popover-body";

    // Display row (title trigger + edit icon button + AI generate icon button)
    this.displayEl = document.createElement("div");
    this.displayEl.className = "hermesian-title-popover-display";

    this.titleTriggerEl = document.createElement("button");
    this.titleTriggerEl.type = "button";
    this.titleTriggerEl.className = "hermesian-title-popover-title-trigger";
    this.titleTriggerEl.title = "点击修改标题";
    this.titleTriggerEl.setAttribute("aria-label", "点击修改标题");

    this.titleTextEl = document.createElement("span");
    this.titleTextEl.className = "hermesian-title-popover-title-text";
    this.titleTextEl.textContent = this.currentTitle;
    this.titleTriggerEl.appendChild(this.titleTextEl);
    this.titleTriggerEl.addEventListener("click", () => {
      this.enterEditMode();
    });

    this.editButtonEl = document.createElement("button");
    this.editButtonEl.type = "button";
    this.editButtonEl.className =
      "clickable-icon hermesian-title-popover-icon-button hermesian-title-popover-edit-button";
    this.editButtonEl.title = "编辑标题";
    this.editButtonEl.setAttribute("aria-label", "编辑标题");

    const pencilIconEl = document.createElement("span");
    pencilIconEl.className = "hermesian-title-popover-pencil-icon";
    this.iconRenderer(pencilIconEl, "pencil");
    this.editButtonEl.appendChild(pencilIconEl);
    this.editButtonEl.addEventListener("click", () => {
      this.enterEditMode();
    });

    this.aiButtonEl = document.createElement("button");
    this.aiButtonEl.type = "button";
    this.aiButtonEl.className =
      "clickable-icon hermesian-title-popover-icon-button hermesian-title-popover-ai-button";

    const aiIconEl = document.createElement("span");
    aiIconEl.className = "hermesian-title-popover-ai-icon";
    this.iconRenderer(aiIconEl, "sparkles");

    this.aiButtonEl.appendChild(aiIconEl);
    this.aiButtonEl.addEventListener("click", () => {
      void this.runAiGenerate();
    });

    this.displayEl.append(this.titleTriggerEl, this.editButtonEl, this.aiButtonEl);

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

    // Actions row (model & reasoning selectors)
    const actionsEl = document.createElement("div");
    actionsEl.className = "hermesian-title-popover-actions";

    const aiControlsEl = document.createElement("div");
    aiControlsEl.className = "hermesian-title-popover-ai-controls";

    this.aiModelButtonEl = document.createElement("button");
    this.aiModelButtonEl.type = "button";
    this.aiModelButtonEl.className =
      "hermesian-title-popover-option-button hermesian-title-popover-model-button";
    const modelIconEl = document.createElement("span");
    modelIconEl.className = "hermesian-title-popover-option-icon";
    this.iconRenderer(modelIconEl, "bot");
    this.aiModelLabelEl = document.createElement("span");
    this.aiModelLabelEl.className = "hermesian-title-popover-option-label";
    const modelChevronEl = document.createElement("span");
    modelChevronEl.className = "hermesian-title-popover-option-chevron";
    this.iconRenderer(modelChevronEl, "chevron-down");
    this.aiModelButtonEl.append(modelIconEl, this.aiModelLabelEl, modelChevronEl);
    this.aiModelButtonEl.addEventListener("click", () => {
      this.enterSubPickerMode("model");
    });

    this.aiReasoningButtonEl = document.createElement("button");
    this.aiReasoningButtonEl.type = "button";
    this.aiReasoningButtonEl.className =
      "hermesian-title-popover-option-button hermesian-title-popover-reasoning-button";
    const reasoningIconEl = document.createElement("span");
    reasoningIconEl.className = "hermesian-title-popover-option-icon";
    this.iconRenderer(reasoningIconEl, "brain");
    this.aiReasoningLabelEl = document.createElement("span");
    this.aiReasoningLabelEl.className = "hermesian-title-popover-option-label";
    this.aiReasoningButtonEl.append(reasoningIconEl, this.aiReasoningLabelEl);
    this.aiReasoningButtonEl.addEventListener("click", () => {
      this.enterSubPickerMode("reasoning");
    });

    aiControlsEl.append(this.aiModelButtonEl, this.aiReasoningButtonEl);
    actionsEl.append(aiControlsEl);

    // Error alert
    this.errorEl = document.createElement("div");
    this.errorEl.className = "hermesian-title-popover-error";
    this.errorEl.setAttribute("role", "alert");
    this.errorEl.style.display = "none";

    this.mainBodyEl.append(this.displayEl, this.inputEl, actionsEl, this.errorEl);

    // Sub-picker pane (hidden in main mode)
    this.pickerPaneEl = document.createElement("div");
    this.pickerPaneEl.className = "hermesian-title-popover-picker";
    this.pickerPaneEl.style.display = "none";

    const subHeaderEl = document.createElement("div");
    subHeaderEl.className = "hermesian-title-popover-subview-header";

    this.pickerBackButtonEl = document.createElement("button");
    this.pickerBackButtonEl.type = "button";
    this.pickerBackButtonEl.className =
      "clickable-icon hermesian-title-popover-back-button";
    this.pickerBackButtonEl.title = "返回";
    this.pickerBackButtonEl.setAttribute("aria-label", "返回");
    const backIconEl = document.createElement("span");
    this.pickerBackButtonEl.appendChild(backIconEl);
    this.iconRenderer(backIconEl, "chevron-left");
    this.pickerBackButtonEl.addEventListener("click", () => {
      this.exitSubPickerMode();
    });

    this.pickerTitleEl = document.createElement("span");
    this.pickerTitleEl.className = "hermesian-title-popover-subview-title";
    subHeaderEl.append(this.pickerBackButtonEl, this.pickerTitleEl);

    this.pickerSearchEl = document.createElement("input");
    this.pickerSearchEl.type = "text";
    this.pickerSearchEl.className = "hermesian-title-popover-search";
    this.pickerSearchEl.placeholder = "搜索模型或提供商…";
    this.pickerSearchEl.setAttribute("aria-label", "搜索标题生成模型");
    this.pickerSearchEl.addEventListener("input", () => {
      this.modelQuery = this.pickerSearchEl.value;
      if (this.mode === "model") {
        this.renderModelPickerList();
      }
    });

    this.pickerListEl = document.createElement("div");
    this.pickerListEl.className = "hermesian-title-popover-picker-list";
    this.pickerListEl.setAttribute("role", "listbox");
    this.pickerListEl.tabIndex = -1;

    this.pickerPaneEl.append(subHeaderEl, this.pickerSearchEl, this.pickerListEl);
    this.containerEl.append(headerEl, this.mainBodyEl, this.pickerPaneEl);

    this.updateAiButtonState();
    this.renderAiOptionControls();
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
    this.titleTriggerEl.focus();
  }

  detach(): void {
    if (!this.isOpenFlag) {
      return;
    }
    this.isOpenFlag = false;
    this.mode = "main";
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

  updateAiOptions(options: {
    models?: HermesModelOption[];
    catalogLoading?: boolean;
    hiddenModelSwitchIds?: string[];
    selectedAiModel?: HermesModelOption;
    selectedAiReasoningEffort?: ReasoningEffort;
  }): void {
    if (options.models !== undefined) {
      this.models = [...options.models];
    }
    if (options.catalogLoading !== undefined) {
      this.catalogLoading = options.catalogLoading;
    }
    if (options.hiddenModelSwitchIds !== undefined) {
      this.hiddenModelSwitchIds = [...options.hiddenModelSwitchIds];
    }
    if ("selectedAiModel" in options) {
      this.selectedAiModel = options.selectedAiModel;
    }
    if (options.selectedAiReasoningEffort !== undefined) {
      this.selectedAiReasoningEffort = options.selectedAiReasoningEffort;
    }
    this.renderAiOptionControls();
    if (this.mode === "model") {
      this.renderModelPickerList();
    } else if (this.mode === "reasoning") {
      this.renderReasoningPickerList();
    }
  }

  private renderAiOptionControls(): void {
    const model = this.selectedAiModel;
    const modelLabel = model ? model.modelId : "默认模型";
    const modelTooltip = model
      ? `标题生成模型: ${model.providerName} · ${model.modelId}`
      : "标题生成模型: 跟随 Hermes 默认配置";
    this.aiModelLabelEl.textContent = modelLabel;
    this.aiModelButtonEl.title = modelTooltip;
    this.aiModelButtonEl.setAttribute("aria-label", modelTooltip);

    const effort = this.selectedAiReasoningEffort;
    const effortLabel = titleEffortCapsuleLabel(effort);
    const effortTooltip = `标题生成思考度: ${effort} (${TITLE_EFFORT_DESCRIPTIONS[effort]})`;
    this.aiReasoningLabelEl.textContent = effortLabel;
    this.aiReasoningButtonEl.title = effortTooltip;
    this.aiReasoningButtonEl.setAttribute("aria-label", effortTooltip);
  }

  private enterSubPickerMode(nextMode: "model" | "reasoning"): void {
    if (this.isBusy) {
      return;
    }
    this.mode = nextMode;
    this.clearError();
    this.mainBodyEl.style.display = "none";
    this.pickerPaneEl.style.display = "";

    if (nextMode === "model") {
      this.pickerTitleEl.textContent = "标题生成模型";
      this.modelQuery = "";
      this.pickerSearchEl.value = "";
      this.pickerSearchEl.style.display = "";
      this.renderModelPickerList();
      this.position();
      this.pickerSearchEl.focus();
    } else {
      this.pickerTitleEl.textContent = "标题生成思考度";
      this.pickerSearchEl.style.display = "none";
      this.renderReasoningPickerList();
      this.position();
      this.pickerListEl.focus();
    }
  }

  private exitSubPickerMode(): void {
    const previousMode = this.mode;
    this.mode = "main";
    this.renderedPickerActions = [];
    this.activePickerIndex = -1;
    this.pickerPaneEl.style.display = "none";
    this.mainBodyEl.style.display = "";
    this.position();
    if (previousMode === "model") {
      this.aiModelButtonEl.focus();
    } else if (previousMode === "reasoning") {
      this.aiReasoningButtonEl.focus();
    } else {
      this.titleTriggerEl.focus();
    }
  }

  private setActivePickerIndex(index: number): void {
    if (this.renderedPickerActions.length === 0 || index < 0) {
      this.activePickerIndex = -1;
      return;
    }
    this.activePickerIndex =
      ((index % this.renderedPickerActions.length) + this.renderedPickerActions.length) %
      this.renderedPickerActions.length;
    this.renderedPickerActions.forEach(({ el }, i) => {
      el.classList.toggle("is-active", i === this.activePickerIndex);
      if (i === this.activePickerIndex) {
        el.scrollIntoView?.({ block: "nearest" });
      }
    });
  }

  private renderModelPickerList(): void {
    this.pickerListEl.replaceChildren();
    this.renderedPickerActions = [];
    this.activePickerIndex = -1;
    this.pickerListEl.setAttribute("aria-label", "可选标题生成模型");

    const fragment = document.createDocumentFragment();
    const normalizedQuery = this.modelQuery.trim().toLowerCase();
    const showDefaultOption =
      !normalizedQuery ||
      "默认模型 跟随 hermes default auto".includes(normalizedQuery);

    if (showDefaultOption) {
      const defaultRow = this.createPickerOptionRow({
        title: "跟随 Hermes 默认",
        subtitle: "使用 Hermes auxiliary.title_generation 配置",
        selected: !this.selectedAiModel,
        onChoose: () => this.chooseAiModel(undefined),
      });
      fragment.appendChild(defaultRow);
    }

    const visibleModels = searchModels(
      filterVisibleModels(
        this.models,
        this.hiddenModelSwitchIds,
        this.selectedAiModel?.switchId,
      ),
      this.modelQuery,
    );

    const groups = groupModelsByProvider(visibleModels);
    for (const group of groups) {
      const isExpanded = this.isProviderGroupExpanded(group, groups.length);
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
        const nextExpanded = !isExpanded;
        this.sessionProviderToggles.set(group.id, nextExpanded);
        this.providerExpansion = {
          ...this.providerExpansion,
          [group.id]: nextExpanded,
        };
        void Promise.resolve(
          this.options.onSaveProviderExpansion?.({ ...this.providerExpansion }),
        ).catch(() => {});
        this.renderModelPickerList();
      });
      groupEl.appendChild(headerBtn);

      const itemsEl = document.createElement("div");
      itemsEl.className = "hermesian-model-group-items";

      for (const model of group.models) {
        const optionEl = this.createPickerOptionRow({
          title: model.name,
          subtitle: model.description,
          selected: model.switchId === this.selectedAiModel?.switchId,
          registerKeyboardAction: isExpanded,
          tooltip: model.description
            ? `${model.providerName} · ${model.modelId} — ${model.description}`
            : `${model.providerName} · ${model.modelId}`,
          onChoose: () => this.chooseAiModel(model),
        });
        itemsEl.appendChild(optionEl);
      }
      groupEl.appendChild(itemsEl);
      fragment.appendChild(groupEl);
    }

    if (!showDefaultOption && visibleModels.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "hermesian-title-popover-picker-empty";
      emptyEl.textContent = "没有匹配的模型";
      fragment.appendChild(emptyEl);
    } else if (this.models.length === 0) {
      const hintEl = document.createElement("div");
      hintEl.className = "hermesian-title-popover-picker-empty";
      hintEl.textContent = this.catalogLoading
        ? "正在加载 Hermes 模型列表…"
        : "暂无更多可用模型（可先连接任意会话）";
      fragment.appendChild(hintEl);
    }

    this.pickerListEl.appendChild(fragment);

    const selectedIdx = this.renderedPickerActions.findIndex(
      ({ el }) => el.getAttribute("aria-selected") === "true",
    );
    if (selectedIdx >= 0) {
      this.setActivePickerIndex(selectedIdx);
    } else if (this.renderedPickerActions.length > 0) {
      this.setActivePickerIndex(0);
    }
  }

  private renderReasoningPickerList(): void {
    this.pickerListEl.replaceChildren();
    this.renderedPickerActions = [];
    this.activePickerIndex = -1;
    this.pickerListEl.setAttribute("aria-label", "可选思考度");

    const fragment = document.createDocumentFragment();
    for (const effort of TITLE_REASONING_EFFORTS) {
      const optionEl = this.createPickerOptionRow({
        title: titleEffortOptionLabel(effort),
        subtitle: TITLE_EFFORT_DESCRIPTIONS[effort],
        selected: effort === this.selectedAiReasoningEffort,
        onChoose: () => this.chooseAiReasoning(effort),
      });
      fragment.appendChild(optionEl);
    }
    this.pickerListEl.appendChild(fragment);

    const selectedIdx = this.renderedPickerActions.findIndex(
      ({ el }) => el.getAttribute("aria-selected") === "true",
    );
    this.setActivePickerIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }

  private isProviderGroupExpanded(
    group: HermesProviderModels,
    totalGroups: number,
  ): boolean {
    if (this.modelQuery.trim()) {
      return true;
    }
    if (this.sessionProviderToggles.has(group.id)) {
      return this.sessionProviderToggles.get(group.id)!;
    }
    if (
      this.selectedAiModel?.switchId &&
      group.models.some((model) => model.switchId === this.selectedAiModel?.switchId)
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

  private createPickerOptionRow(params: {
    title: string;
    subtitle: string;
    selected: boolean;
    registerKeyboardAction?: boolean;
    tooltip?: string;
    onChoose: () => void;
  }): HTMLElement {
    const optionEl = document.createElement("div");
    optionEl.className = params.selected
      ? "hermesian-title-popover-picker-option is-selected"
      : "hermesian-title-popover-picker-option";
    optionEl.setAttribute("role", "option");
    optionEl.setAttribute("aria-selected", String(params.selected));
    optionEl.tabIndex = -1;
    if (params.tooltip) {
      optionEl.title = params.tooltip;
    }

    const copyEl = document.createElement("div");
    copyEl.className = "hermesian-title-popover-picker-option-copy";
    const titleEl = document.createElement("div");
    titleEl.className = "hermesian-title-popover-picker-option-name";
    titleEl.textContent = params.title;
    copyEl.appendChild(titleEl);
    if (params.subtitle) {
      const subtitleEl = document.createElement("div");
      subtitleEl.className = "hermesian-title-popover-picker-option-desc";
      subtitleEl.textContent = params.subtitle;
      copyEl.appendChild(subtitleEl);
    }
    optionEl.appendChild(copyEl);

    if (params.selected) {
      const checkEl = document.createElement("span");
      checkEl.className = "hermesian-title-popover-picker-option-check";
      checkEl.setAttribute("aria-hidden", "true");
      this.iconRenderer(checkEl, "check");
      optionEl.appendChild(checkEl);
    }

    if (params.registerKeyboardAction !== false) {
      const index = this.renderedPickerActions.length;
      optionEl.addEventListener("pointerenter", () => {
        this.setActivePickerIndex(index);
      });
      this.renderedPickerActions.push({ el: optionEl, onChoose: params.onChoose });
    }
    optionEl.addEventListener("click", () => {
      params.onChoose();
    });
    return optionEl;
  }

  private chooseAiModel(model: HermesModelOption | undefined): void {
    const previous = this.selectedAiModel;
    this.selectedAiModel = model;
    this.renderAiOptionControls();
    this.exitSubPickerMode();
    if (!this.options.onSelectAiModel) {
      return;
    }
    void Promise.resolve(this.options.onSelectAiModel(model)).catch((error) => {
      this.selectedAiModel = previous;
      this.renderAiOptionControls();
      const message = error instanceof Error ? error.message : String(error);
      this.showError(message);
    });
  }

  private chooseAiReasoning(effort: ReasoningEffort): void {
    const previous = this.selectedAiReasoningEffort;
    this.selectedAiReasoningEffort = effort;
    this.renderAiOptionControls();
    this.exitSubPickerMode();
    if (!this.options.onSelectAiReasoning) {
      return;
    }
    void Promise.resolve(this.options.onSelectAiReasoning(effort)).catch((error) => {
      this.selectedAiReasoningEffort = previous;
      this.renderAiOptionControls();
      const message = error instanceof Error ? error.message : String(error);
      this.showError(message);
    });
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
    this.titleTriggerEl.focus();
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
      const tooltip = this.isBusy ? "正在生成标题…" : "使用 AI 生成会话标题";
      this.aiButtonEl.disabled = this.isBusy;
      this.aiButtonEl.title = tooltip;
      this.aiButtonEl.setAttribute("aria-label", tooltip);
      this.aiButtonEl.removeAttribute("aria-disabled");
    } else {
      this.aiButtonEl.disabled = true;
      this.aiButtonEl.title = "发送消息后可用";
      this.aiButtonEl.setAttribute("aria-label", "发送消息后可用");
      this.aiButtonEl.setAttribute("aria-disabled", "true");
    }
  }

  private setBusy(busy: boolean, isAi = false): void {
    this.isBusy = busy;
    this.titleTriggerEl.disabled = busy;
    this.editButtonEl.disabled = busy;
    this.inputEl.disabled = busy;
    this.aiModelButtonEl.disabled = busy;
    this.aiReasoningButtonEl.disabled = busy;
    this.aiButtonEl.classList.toggle("is-loading", busy && isAi);
    if (busy) {
      if (isAi) {
        this.aiButtonEl.setAttribute("aria-busy", "true");
        this.aiButtonEl.title = "正在生成标题…";
        this.aiButtonEl.setAttribute("aria-label", "正在生成标题…");
      } else {
        this.aiButtonEl.removeAttribute("aria-busy");
      }
      this.aiButtonEl.disabled = true;
    } else {
      this.aiButtonEl.removeAttribute("aria-busy");
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
      if (this.isOpenFlag && !this.isEditing && this.mode === "main") {
        this.titleTriggerEl.focus();
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
      popoverHeightMax:
        this.mode === "main" ? POPOVER_HEIGHT_MAX : PICKER_POPOVER_HEIGHT_MAX,
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
