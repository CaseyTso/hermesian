import {
  addIcon,
  FileSystemAdapter,
  type MarkdownFileInfo,
  MarkdownView,
  Notice,
  Plugin,
  WorkspaceLeaf,
} from "obsidian";

import {
  automaticVaultEditApproval,
  HermesAcpClient,
  type PermissionRequest,
  type PermissionResponse,
} from "./acp-client";
import {
  normalizeConversationWorkspace,
  type PersistedConversationWorkspace,
} from "./conversation-tabs";
import { HERMESIAN_ICON_ID, HERMESIAN_ICON_SVG } from "./hermes-icon";
import { chooseMarkdownSource } from "./markdown-source";
import { isReasoningEffort } from "./session-history";
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
import { TabClientRegistry } from "./tab-client-registry";
import {
  HERMESIAN_VIEW_TYPE,
  HermesianSidebarView,
} from "./view";
import type { MarkdownDocumentContext, ReasoningEffort } from "./types";

export default class HermesianPlugin extends Plugin {
  settings: HermesianSettings = { ...DEFAULT_SETTINGS };

  private readonly clients = new TabClientRegistry<HermesAcpClient>(
    (tabId, isCurrent) => {
      const client = new HermesAcpClient({
        onEvent: (event) => {
          if (isCurrent()) {
            this.sidebarView?.handleHermesEvent(tabId, event);
          }
        },
        onPermission: (request, signal) =>
          isCurrent()
            ? (this.sidebarView?.requestPermission(tabId, request, signal) ??
              Promise.resolve({ outcome: { outcome: "cancelled" } }))
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        pluginVersion: this.manifest.version,
        settings: () => this.settings,
        vaultPath: this.getVaultPath(),
      });
      const unsubscribe = client.onSessionState((state) => {
        if (isCurrent()) {
          this.sidebarView?.handleHermesSessionState(tabId, state);
        }
      });
      return { client, unsubscribe };
    },
  );
  private conversationWorkspace: PersistedConversationWorkspace | undefined;
  private conversationWorkspaceSaveTimer: number | undefined;
  private lastMarkdownView: MarkdownView | undefined;
  private sidebarView: HermesianSidebarView | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    addIcon(HERMESIAN_ICON_ID, HERMESIAN_ICON_SVG);

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

    this.addRibbonIcon(HERMESIAN_ICON_ID, "Open Hermesian", () => {
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
      name: "Restart current conversation",
      callback: () => {
        void this.startNewSession();
      },
    });

    this.addSettingTab(new HermesianSettingTab(this.app, this));
  }

  onunload(): void {
    if (this.conversationWorkspaceSaveTimer !== undefined) {
      window.clearTimeout(this.conversationWorkspaceSaveTimer);
      this.conversationWorkspaceSaveTimer = undefined;
      void this.savePluginData();
    }
    void this.disconnectAllClients();
    this.app.workspace.detachLeavesOfType(HERMESIAN_VIEW_TYPE);
  }

  attachView(view: HermesianSidebarView): void {
    this.sidebarView = view;
    view.setCurrentFile(this.currentMarkdownFilePath());
  }

  async releaseView(view: HermesianSidebarView): Promise<void> {
    if (this.sidebarView === view) {
      this.sidebarView = undefined;
      await this.disconnectAllClients();
    }
  }

  getClient(tabId: string): HermesAcpClient {
    return this.clients.getOrCreate(tabId);
  }

  automaticPermissionResponse(
    request: PermissionRequest,
  ): PermissionResponse | undefined {
    return automaticVaultEditApproval(
      request,
      this.getVaultPath(),
      this.settings.autoApproveVaultEdits,
    );
  }

  peekClient(tabId: string): HermesAcpClient | undefined {
    return this.clients.peek(tabId);
  }

  hasBusyClient(): boolean {
    return this.clients.some((client) => client.isBusy || client.isOperating);
  }

  async releaseClient(tabId: string): Promise<void> {
    await this.clients.release(tabId);
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
    await this.flushConversationWorkspace();
  }

  getConversationWorkspace(): PersistedConversationWorkspace | undefined {
    return normalizeConversationWorkspace(this.conversationWorkspace);
  }

  setConversationWorkspace(workspace: PersistedConversationWorkspace): void {
    this.conversationWorkspace = workspace;
    if (this.conversationWorkspaceSaveTimer !== undefined) {
      window.clearTimeout(this.conversationWorkspaceSaveTimer);
    }
    this.conversationWorkspaceSaveTimer = window.setTimeout(() => {
      this.conversationWorkspaceSaveTimer = undefined;
      void this.savePluginData();
    }, 250);
  }

  async flushConversationWorkspace(
    workspace?: PersistedConversationWorkspace,
  ): Promise<void> {
    if (workspace) {
      this.conversationWorkspace = workspace;
    }
    if (this.conversationWorkspaceSaveTimer !== undefined) {
      window.clearTimeout(this.conversationWorkspaceSaveTimer);
      this.conversationWorkspaceSaveTimer = undefined;
    }
    await this.savePluginData();
  }

  async saveSettingsAndReconnect(): Promise<void> {
    await this.saveSettings();
    await this.disconnectAllClients();
  }

  getReasoningEffort(): ReasoningEffort {
    return this.settings.reasoningEffort;
  }

  async setReasoningEffort(tabId: string, effort: ReasoningEffort): Promise<void> {
    if (this.hasBusyClient()) {
      throw new Error("Cannot change thinking depth while Hermes is responding");
    }
    await this.getClient(tabId).configureReasoningEffort(effort);
    this.settings.reasoningEffort = effort;
    await this.saveSettings();
    await this.disconnectAllClients();
  }

  private async disconnectAllClients(): Promise<void> {
    await this.clients.releaseAll();
  }

  private async startNewSession(): Promise<void> {
    const view = await this.activateView();
    if (!view) {
      return;
    }
    try {
      await view.startNewSession();
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
    const loaded = await this.loadData();
    const saved =
      loaded && typeof loaded === "object"
        ? (loaded as Partial<HermesianSettings> & {
            conversationWorkspace?: unknown;
          })
        : {};
    this.settings = {
      acceptHooks:
        typeof saved.acceptHooks === "boolean"
          ? saved.acceptHooks
          : DEFAULT_SETTINGS.acceptHooks,
      autoApproveVaultEdits:
        typeof saved.autoApproveVaultEdits === "boolean"
          ? saved.autoApproveVaultEdits
          : DEFAULT_SETTINGS.autoApproveVaultEdits,
      hermesExecutable:
        typeof saved.hermesExecutable === "string"
          ? saved.hermesExecutable
          : DEFAULT_SETTINGS.hermesExecutable,
      profile:
        typeof saved.profile === "string" ? saved.profile : DEFAULT_SETTINGS.profile,
      reasoningEffort:
        typeof saved.reasoningEffort === "string" &&
        isReasoningEffort(saved.reasoningEffort)
          ? saved.reasoningEffort
          : DEFAULT_SETTINGS.reasoningEffort,
    };
    this.conversationWorkspace = normalizeConversationWorkspace(
      saved.conversationWorkspace,
    );
    if (!isReasoningEffort(String(this.settings.reasoningEffort))) {
      this.settings.reasoningEffort = DEFAULT_SETTINGS.reasoningEffort;
    }
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      ...this.settings,
      conversationWorkspace: this.conversationWorkspace,
    });
  }
}
