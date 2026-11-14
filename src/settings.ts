import { App, PluginSettingTab, Setting, setIcon } from "obsidian";

import { loadHermesModelCatalog } from "./hermes-model-catalog";
import type HermesianPlugin from "./main";
import type { HermesModelOption, ReasoningEffort } from "./types";
import { searchModels } from "./ui/model-picker-popover";

export interface HermesianSettings {
  acceptHooks: boolean;
  autoApproveVaultEdits: boolean;
  debugLogging: boolean;
  hermesExecutable: string;
  hiddenModelSwitchIds: string[];
  modelProviderExpansion: Record<string, boolean>;
  profile: string;
  reasoningEffort: ReasoningEffort;
  titleGenerationModel?: HermesModelOption;
  titleGenerationReasoningEffort?: ReasoningEffort;
}

export const DEFAULT_SETTINGS: HermesianSettings = {
  acceptHooks: true,
  autoApproveVaultEdits: true,
  debugLogging: false,
  hermesExecutable: "hermes",
  hiddenModelSwitchIds: [],
  modelProviderExpansion: {},
  profile: "default",
  reasoningEffort: "default",
  titleGenerationModel: undefined,
  titleGenerationReasoningEffort: "none",
};

export class HermesianSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HermesianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Hermesian" });

    const draft = this.plugin.getConnectionSettings();

    new Setting(containerEl)
      .setName("Hermes executable")
      .setDesc(
        "Executable name or absolute path. Hermesian also checks ~/.local/bin/hermes and common Homebrew locations when set to 'hermes'.",
      )
      .addText((text) =>
        text
          .setPlaceholder("hermes")
          .setValue(draft.hermesExecutable)
          .onChange((value) => {
            draft.hermesExecutable = value.trim() || "hermes";
          }),
      );

    new Setting(containerEl)
      .setName("Hermes profile")
      .setDesc(
        "Profile selected with Hermes' --profile flag. Use 'default' for the default Hermes profile; credentials stay in Hermes.",
      )
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(draft.profile)
          .onChange((value) => {
            draft.profile = value.trim();
          }),
      );

    new Setting(containerEl)
      .setName("Accept Hermes startup hooks")
      .setDesc(
        "Pass --accept-hooks and HERMES_ACCEPT_HOOKS=1 so ACP can start non-interactively. This does not auto-approve tool or file edits.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(draft.acceptHooks)
          .onChange((value) => {
            draft.acceptHooks = value;
          }),
      );

    new Setting(containerEl)
      .setName("Apply connection settings")
      .setDesc(
        "Save the executable, profile and hook settings above and restart active Hermes connections. Only available when all conversations are idle.",
      )
      .addButton((button) =>
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(async () => {
            const applied = await this.plugin.applyConnectionSettings({
              acceptHooks: draft.acceptHooks,
              hermesExecutable: draft.hermesExecutable,
              profile: draft.profile,
            });
            if (applied) {
              this.display();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Automatically approve Vault edits")
      .setDesc(
        "Allow patch/write edits only when ACP provides a diff and every canonical target stays inside this Vault. Terminal commands and unverifiable writes still require approval.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoApproveVaultEdits)
          .onChange(async (value) => {
            this.plugin.settings.autoApproveVaultEdits = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Write privacy-safe lifecycle events (connection, operations, errors) to the developer console. Does not log prompt text, file paths, or session IDs.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Visible models by provider")
      .setDesc(
        "Configure which model IDs are shown for each provider in the model picker. Expand a provider to toggle individual model IDs or use All / None.",
      );
    const hiddenModelsContainer = containerEl.createDiv({ cls: "hermesian-hidden-models" });
    void this.renderHiddenModels(hiddenModelsContainer);
  }

  private async renderHiddenModels(containerEl: HTMLElement): Promise<void> {
    containerEl.empty();
    try {
      const catalog = await loadHermesModelCatalog(
        this.plugin.settings.hermesExecutable,
        this.plugin.settings.profile,
      );
      if (catalog.providers.length === 0) {
        containerEl.createDiv({
          cls: "hermesian-hidden-models-error",
          text: "No configured Hermes providers found.",
        });
        return;
      }

      const toolbarEl = containerEl.createDiv({
        cls: "hermesian-hidden-models-toolbar",
      });
      const searchInputEl = toolbarEl.createEl("input", {
        cls: "hermesian-model-popover-search hermesian-hidden-models-search",
        type: "text",
        placeholder: "Filter provider or model ID…",
      });
      const summaryEl = toolbarEl.createSpan({
        cls: "hermesian-model-popover-manage-summary",
      });

      const listEl = containerEl.createDiv({
        cls: "hermesian-hidden-models-list",
      });

      const expandedProviders = new Map<string, boolean>();
      let filterQuery = "";
      let saving = false;

      const allModels = catalog.providers.flatMap((p) => p.models);

      const syncSummaryAndControls = (): void => {
        const hiddenSet = new Set(this.plugin.settings.hiddenModelSwitchIds);
        const visibleTotal = allModels.filter(
          (m) => !hiddenSet.has(m.switchId),
        ).length;
        summaryEl.textContent = `${visibleTotal} / ${allModels.length}`;

        for (const checkbox of listEl.querySelectorAll<HTMLInputElement>(
          "input[type=checkbox]",
        )) {
          checkbox.checked = !hiddenSet.has(checkbox.value);
          checkbox.disabled = saving;
        }

        for (const groupEl of listEl.querySelectorAll<HTMLElement>(
          ".hermesian-model-manage-group",
        )) {
          const providerId = groupEl.dataset.providerId ?? "";
          const provider = catalog.providers.find((p) => p.id === providerId);
          if (!provider) {
            continue;
          }
          const visibleModels = searchModels(provider.models, filterQuery);
          const enabledInProvider = provider.models.filter(
            (m) => !hiddenSet.has(m.switchId),
          ).length;
          const countEl = groupEl.querySelector<HTMLElement>(
            ".hermesian-model-group-count",
          );
          if (countEl) {
            countEl.textContent = `${enabledInProvider}/${provider.models.length}`;
            countEl.classList.toggle("is-zero", enabledInProvider === 0);
          }
          const allBtn = groupEl.querySelector<HTMLButtonElement>(
            "[data-bulk-action='all']",
          );
          if (allBtn) {
            allBtn.disabled =
              saving ||
              visibleModels.every((m) => !hiddenSet.has(m.switchId));
          }
          const noneBtn = groupEl.querySelector<HTMLButtonElement>(
            "[data-bulk-action='none']",
          );
          if (noneBtn) {
            noneBtn.disabled =
              saving ||
              visibleModels.every((m) => hiddenSet.has(m.switchId));
          }
        }
      };

      const saveHiddenSet = async (nextHidden: Set<string>): Promise<void> => {
        if (saving) {
          syncSummaryAndControls();
          return;
        }
        saving = true;
        syncSummaryAndControls();
        try {
          await this.plugin.saveHiddenModelSwitchIds([...nextHidden]);
        } catch {
          // Plugin entry point shows Notice and rolls back in-memory settings
        } finally {
          saving = false;
          syncSummaryAndControls();
        }
      };

      const renderGroups = (): void => {
        listEl.empty();
        const hiddenSet = new Set(this.plugin.settings.hiddenModelSwitchIds);
        const visibleTotal = allModels.filter(
          (m) => !hiddenSet.has(m.switchId),
        ).length;
        summaryEl.textContent = `${visibleTotal} / ${allModels.length}`;

        let matchedAny = false;
        for (const provider of catalog.providers) {
          const matchedModels = searchModels(provider.models, filterQuery);
          if (matchedModels.length === 0) {
            continue;
          }
          matchedAny = true;
          const isExpanded = filterQuery.trim()
            ? true
            : (expandedProviders.get(provider.id) ??
              (catalog.providers.length === 1 ||
                provider.id === catalog.currentProviderId));

          const groupEl = listEl.createDiv({
            cls: isExpanded
              ? "hermesian-model-group hermesian-model-manage-group"
              : "hermesian-model-group hermesian-model-manage-group is-collapsed",
          });
          groupEl.dataset.providerId = provider.id;

          const headerRowEl = groupEl.createDiv({
            cls: "hermesian-model-manage-group-header",
          });

          const toggleBtn = headerRowEl.createEl("button", {
            cls: "hermesian-model-group-toggle",
            type: "button",
          });
          toggleBtn.setAttribute("aria-expanded", String(isExpanded));

          const chevronEl = toggleBtn.createSpan({
            cls: "hermesian-model-group-chevron",
          });
          setIcon(chevronEl, isExpanded ? "chevron-down" : "chevron-right");

          toggleBtn.createSpan({
            cls: "hermesian-model-group-label",
            text: provider.label,
          });

          const enabledCount = provider.models.filter(
            (m) => !hiddenSet.has(m.switchId),
          ).length;
          const countEl = toggleBtn.createSpan({
            cls:
              enabledCount === 0
                ? "hermesian-model-group-count is-zero"
                : "hermesian-model-group-count",
            text: `${enabledCount}/${provider.models.length}`,
          });
          void countEl;

          toggleBtn.addEventListener("click", () => {
            expandedProviders.set(provider.id, !isExpanded);
            renderGroups();
          });

          const actionsEl = headerRowEl.createDiv({
            cls: "hermesian-model-manage-group-actions",
          });

          const allBtn = actionsEl.createEl("button", {
            cls: "hermesian-model-manage-bulk-btn",
            text: "All",
            type: "button",
          });
          allBtn.dataset.bulkAction = "all";
          allBtn.title = `Show all models in ${provider.label}`;
          allBtn.disabled =
            saving || matchedModels.every((m) => !hiddenSet.has(m.switchId));
          allBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            const next = new Set(this.plugin.settings.hiddenModelSwitchIds);
            for (const m of matchedModels) {
              next.delete(m.switchId);
            }
            void saveHiddenSet(next);
          });

          const noneBtn = actionsEl.createEl("button", {
            cls: "hermesian-model-manage-bulk-btn",
            text: "None",
            type: "button",
          });
          noneBtn.dataset.bulkAction = "none";
          noneBtn.title = `Hide all models in ${provider.label}`;
          noneBtn.disabled =
            saving || matchedModels.every((m) => hiddenSet.has(m.switchId));
          noneBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            const next = new Set(this.plugin.settings.hiddenModelSwitchIds);
            for (const m of matchedModels) {
              next.add(m.switchId);
            }
            void saveHiddenSet(next);
          });

          const itemsEl = groupEl.createDiv({
            cls: "hermesian-model-group-items",
          });

          for (const model of matchedModels) {
            const row = itemsEl.createEl("label", {
              cls: "hermesian-model-manage-row",
            });
            row.title = model.description
              ? `${model.providerName} · ${model.modelId} — ${model.description}`
              : `${model.providerName} · ${model.modelId}`;
            const checkbox = row.createEl("input", { type: "checkbox" });
            checkbox.value = model.switchId;
            checkbox.checked = !hiddenSet.has(model.switchId);
            checkbox.disabled = saving;
            checkbox.addEventListener("change", () => {
              const next = new Set(this.plugin.settings.hiddenModelSwitchIds);
              if (checkbox.checked) {
                next.delete(model.switchId);
              } else {
                next.add(model.switchId);
              }
              void saveHiddenSet(next);
            });
            const copy = row.createDiv({ cls: "hermesian-model-manage-copy" });
            copy.createDiv({ cls: "hermesian-model-manage-name", text: model.name });
            if (model.description) {
              copy.createDiv({
                cls: "hermesian-model-manage-desc",
                text: model.description,
              });
            }
          }
        }

        if (!matchedAny) {
          listEl.createDiv({
            cls: "hermesian-hidden-models-error",
            text: "No models match your filter.",
          });
        }
      };

      searchInputEl.addEventListener("input", () => {
        filterQuery = searchInputEl.value;
        renderGroups();
      });

      renderGroups();
    } catch {
      containerEl.createDiv({
        cls: "hermesian-hidden-models-error",
        text: "Could not load the Hermes model catalog. Check the Hermes executable and profile settings above, then reopen this tab.",
      });
    }
  }
}
