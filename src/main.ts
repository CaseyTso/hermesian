import {
  FileSystemAdapter,
  type MarkdownFileInfo,
  MarkdownView,
  Notice,
  Plugin,
  WorkspaceLeaf,
} from "obsidian";

import { HermesAcpClient } from "./acp-client";
import { chooseMarkdownSource } from "./markdown-source";
import {
  createDocumentContext,
  createSelectionContext,
  locateUniqueTextSelection,
} from "./selection-context";
import {
  DEFAULT_SETTINGS,
  HermesianSettingTab,
  type HermesianSettings,
} from "./settings";
import {
  HERMESIAN_VIEW_TYPE,
  HermesianSidebarView,
} from "./view";
import type { MarkdownDocumentContext } from "./types";

export default class HermesianPlugin extends Plugin {
  settings: HermesianSettings = { ...DEFAULT_SETTINGS };

  private client: HermesAcpClient | undefined;
  private lastMarkdownView: MarkdownView | undefined;
  private sidebarView: HermesianSidebarView | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.lastMarkdownView =
      this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.rememberMarkdownView(leaf.view);
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file?.extension !== "md") {
          return;
        }
        const activeView =
          this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
        if (activeView?.file?.path === file.path) {
          this.rememberMarkdownView(activeView);
        } else {
          this.sidebarView?.setCurrentFile(file.path);
        }
      }),
    );

    this.registerView(
      HERMESIAN_VIEW_TYPE,
      (leaf) => new HermesianSidebarView(leaf, this),
    );

    this.addRibbonIcon("bot", "Open Hermesian", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-hermesian",
      name: "Open Hermesian sidebar",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "ask-hermes-about-selection",
      name: "Ask Hermes about selection",
      editorCheckCallback: (checking, _editor, view) => {
        if (!view.file) {
          return false;
        }
        if (!checking) {
          void this.captureAndAttachSelection(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "new-hermes-session",
      name: "Start a new Hermes session",
      callback: () => {
        void this.startNewSession();
      },
    });

    this.addSettingTab(new HermesianSettingTab(this.app, this));
  }

  onunload(): void {
    void this.client?.disconnect();
    this.app.workspace.detachLeavesOfType(HERMESIAN_VIEW_TYPE);
  }

  attachView(view: HermesianSidebarView): void {
    this.sidebarView = view;
    view.setCurrentFile(this.currentMarkdownFilePath());
  }

  async releaseView(view: HermesianSidebarView): Promise<void> {
    if (this.sidebarView === view) {
      this.sidebarView = undefined;
      await this.client?.disconnect();
    }
  }

  getClient(): HermesAcpClient {
    if (!this.client) {
      this.client = new HermesAcpClient({
        onEvent: (event) => this.sidebarView?.handleHermesEvent(event),
        onPermission: (request, signal) =>
          this.sidebarView?.requestPermission(request, signal) ??
          Promise.resolve({ outcome: { outcome: "cancelled" } }),
        pluginVersion: this.manifest.version,
        settings: () => this.settings,
        vaultPath: this.getVaultPath(),
      });
    }
    return this.client;
  }

  async activateView(): Promise<HermesianSidebarView | undefined> {
    const existing = this.app.workspace.getLeavesOfType(HERMESIAN_VIEW_TYPE)[0];
    let leaf: WorkspaceLeaf | null = existing ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Hermesian could not open a right sidebar leaf.");
        return undefined;
      }
      await leaf.setViewState({
        type: HERMESIAN_VIEW_TYPE,
        active: true,
      });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof HermesianSidebarView
      ? leaf.view
      : this.sidebarView;
  }

  async captureAndAttachSelection(
    view?: MarkdownFileInfo,
    renderedSelection?: string,
  ): Promise<void> {
    const activeMarkdownView =
      this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
    const markdownView = chooseMarkdownSource<MarkdownFileInfo>(
      view,
      activeMarkdownView,
      this.lastMarkdownView,
    );
    if (!markdownView?.file || !markdownView.editor) {
      new Notice("Open a Markdown note before adding a selection.");
      return;
    }

    const editor = markdownView.editor;
    const content = editor.getValue();
    let from = editor.getCursor("from");
    let to = editor.getCursor("to");
    const renderedRange = renderedSelection
      ? locateUniqueTextSelection(content, renderedSelection)
      : undefined;
    if (renderedRange) {
      from = renderedRange.from;
      to = renderedRange.to;
    } else if (renderedSelection?.trim() && !editor.getSelection().trim()) {
      new Notice(
        "The Reading View selection could not be mapped uniquely to Markdown source. Switch to editing mode and select it again.",
      );
      return;
    }

    const context = createSelectionContext({
      content,
      filePath: markdownView.file.path,
      from,
      to,
      vaultPath: this.getVaultPath(),
    });
    if (!context.selectedText.trim()) {
      new Notice("The current selection or line is empty.");
      return;
    }

    const sidebar = await this.activateView();
    sidebar?.setSelection(context);
  }

  getCurrentDocumentContext(): MarkdownDocumentContext | undefined {
    const activeMarkdownView =
      this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
    const markdownView = chooseMarkdownSource<MarkdownFileInfo>(
      undefined,
      activeMarkdownView,
      this.lastMarkdownView,
    );
    if (!markdownView?.file || !markdownView.editor) {
      return undefined;
    }
    return createDocumentContext({
      content: markdownView.editor.getValue(),
      filePath: markdownView.file.path,
      vaultPath: this.getVaultPath(),
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettingsAndReconnect(): Promise<void> {
    await this.saveSettings();
    if (this.client) {
      await this.client.disconnect();
      this.client = undefined;
    }
  }

  private async startNewSession(): Promise<void> {
    const view = await this.activateView();
    if (!view) {
      return;
    }
    try {
      await this.getClient().newSession();
    } catch (error) {
      new Notice(
        `Hermesian: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Hermesian requires an Obsidian desktop filesystem vault");
    }
    return adapter.getBasePath();
  }

  private currentMarkdownFilePath(): string | undefined {
    return (
      this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ??
      this.lastMarkdownView?.file?.path ??
      undefined
    );
  }

  private rememberMarkdownView(view: MarkdownView): void {
    if (!view.file) {
      return;
    }
    this.lastMarkdownView = view;
    this.sidebarView?.setCurrentFile(view.file.path);
  }

  private async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<HermesianSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }
}
