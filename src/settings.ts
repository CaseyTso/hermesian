import { App, PluginSettingTab, Setting } from "obsidian";

import { loadHermesModelCatalog } from "./hermes-model-catalog";
import type HermesianPlugin from "./main";
import type { ReasoningEffort } from "./types";

export interface HermesianSettings {
  acceptHooks: boolean;
  autoApproveVaultEdits: boolean;
  debugLogging: boolean;
  hermesExecutable: string;
  hiddenModelSwitchIds: string[];
  profile: string;
  reasoningEffort: ReasoningEffort;
}

export const DEFAULT_SETTINGS: HermesianSettings = {
  acceptHooks: true,
  autoApproveVaultEdits: true,
  debugLogging: false,
  hermesExecutable: "hermes",
  hiddenModelSwitchIds: [],
  profile: "default",
  reasoningEffort: "default",
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
      .setName("Hidden models")
      .setDesc(
        "Hide rarely used models from the composer model picker. Hidden models can always be restored here or from the picker's Manage mode.",
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
      for (const provider of catalog.providers) {
        containerEl.createDiv({
          cls: "hermesian-hidden-provider",
          text: provider.label,
        });
        for (const model of provider.models) {
          const row = containerEl.createDiv({ cls: "hermesian-hidden-model-row" });
          const checkbox = row.createEl("input", { type: "checkbox" });
          checkbox.checked = !this.plugin.settings.hiddenModelSwitchIds.includes(
            model.switchId,
          );
          checkbox.addEventListener("change", () => {
            const hidden = new Set(this.plugin.settings.hiddenModelSwitchIds);
            if (checkbox.checked) {
              hidden.delete(model.switchId);
            } else {
              hidden.add(model.switchId);
            }
            this.plugin.settings.hiddenModelSwitchIds = [...hidden];
            void this.plugin.saveSettings();
          });
          const copy = row.createDiv({ cls: "hermesian-hidden-model-copy" });
          copy.createDiv({ cls: "hermesian-hidden-model-name", text: model.name });
          copy.createDiv({
            cls: "hermesian-hidden-model-provider",
            text: model.description
              ? `${model.providerName} · ${model.description}`
              : model.providerName,
          });
        }
      }
    } catch {
      containerEl.createDiv({
        cls: "hermesian-hidden-models-error",
        text: "Could not load the Hermes model catalog. Check the Hermes executable and profile settings above, then reopen this tab.",
      });
    }
  }
}
