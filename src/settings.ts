import { App, PluginSettingTab, Setting } from "obsidian";

import type HermesianPlugin from "./main";

export interface HermesianSettings {
  acceptHooks: boolean;
  hermesExecutable: string;
  profile: string;
}

export const DEFAULT_SETTINGS: HermesianSettings = {
  acceptHooks: true,
  hermesExecutable: "hermes",
  profile: "default",
};

export class HermesianSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HermesianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Hermesian" });

    new Setting(containerEl)
      .setName("Hermes executable")
      .setDesc(
        "Executable name or absolute path. Hermesian also checks ~/.local/bin/hermes and common Homebrew locations when set to ‘hermes’.",
      )
      .addText((text) =>
        text
          .setPlaceholder("hermes")
          .setValue(this.plugin.settings.hermesExecutable)
          .onChange(async (value) => {
            this.plugin.settings.hermesExecutable = value.trim() || "hermes";
            await this.plugin.saveSettingsAndReconnect();
          }),
      );

    new Setting(containerEl)
      .setName("Hermes profile")
      .setDesc(
        "Profile selected with Hermes’ --profile flag. Use ‘default’ for the default Hermes profile; credentials stay in Hermes.",
      )
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(this.plugin.settings.profile)
          .onChange(async (value) => {
            this.plugin.settings.profile = value.trim();
            await this.plugin.saveSettingsAndReconnect();
          }),
      );

    new Setting(containerEl)
      .setName("Accept Hermes startup hooks")
      .setDesc(
        "Pass --accept-hooks and HERMES_ACCEPT_HOOKS=1 so ACP can start non-interactively. This does not auto-approve tool or file edits.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.acceptHooks)
          .onChange(async (value) => {
            this.plugin.settings.acceptHooks = value;
            await this.plugin.saveSettingsAndReconnect();
          }),
      );
  }
}
