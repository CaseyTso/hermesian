import type {
  ContentBlock,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import { diffLines } from "diff";
import {
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

import type HermesianPlugin from "./main";
import {
  ConversationController,
  ConversationControllerError,
  type ConversationControllerSnapshot,
  type ConversationInitializationResult,
} from "./conversation-controller";
import {
  isActiveConversationSession,
  updateConversationTab,
  type PersistedConversationTab,
  type PersistedConversationWorkspace,
} from "./conversation-tabs";
import {
  type ConversationAggregateControlAvailability,
  type ConversationControlAvailability,
} from "./conversation-runtime";
import { linkifyExternalUrls } from "./external-links";
import { HERMESIAN_ICON_ID } from "./hermes-icon";
import {
  buildImagePrompt,
  imageAttachmentFromDataUrl,
  isImageClipboardItem,
  MAX_PASTED_IMAGE_BYTES,
  type PastedImageAttachment,
} from "./image-attachments";
import { normalizeMathDelimiters } from "./markdown-math";
import {
  contextUsageLevel,
  contextUsagePercent,
  formatContextUsage,
} from "./session-state";
import {
  buildActiveNotePrompt,
  buildDocumentPrompt,
  buildSelectionPrompt,
  validateSelectionEdit,
} from "./selection-context";
import { reasoningEffortLabel } from "./session-history";
import {
  HermesHistorySuggestModal,
  HermesReasoningSuggestModal,
} from "./ui/conversation-modals";
import { HermesModelPickerPopover } from "./ui/model-picker-popover";
import {
  renderConversationTabsView,
  type ConversationTabsCallbacks,
} from "./ui/conversation-tabs-view";
import {
  createSidebarShell,
  type SidebarShellCallbacks,
} from "./ui/sidebar-shell";
import {
  MessageRenderer,
  TurnManager,
  type TurnCallbacks,
} from "./ui/message-renderer";
import {
  applyComposerSlashToken,
  applyComposerState,
  createComposerView,
  type ComposerCallbacks,
  type ComposerState,
} from "./ui/composer-view";
import {
  buildSlashOutboundPrompt,
  buildSlashMenuItems,
  composerSlashTokenFromMenuItem,
  restoreComposerSlashDraft,
  serializeComposerSlashDraft,
  slashMenuInsertion,
  type ComposerSlashToken,
  type SlashMenuItem,
} from "./slash-menu";
import {
  hermesEventEndsTurn,
  type HermesHistoryEntry,
  type HermesHistoryItem,
  type HermesModelOption,
  type HermesSessionState,
  type HermesUiEvent,
  type MarkdownDocumentContext,
  type ReasoningEffort,
  type SelectionContext,
} from "./types";
import { HermesAcpClient, type PermissionRequest } from "./acp-client";
import { ViewStartupCoordinator } from "./view-startup";

export const HERMESIAN_VIEW_TYPE = "hermesian-sidebar";

const OBSIDIAN_OUTPUT_RULES = `<hermesian_output_rules>
When referring to a note in the current Obsidian Vault, use an Obsidian wikilink such as [[folder/note|note]]. Preserve heading (#) and block (^) suffixes when relevant. Do not wrap wikilinks in backticks or code blocks.
</hermesian_output_rules>`;

const DISABLED_CONVERSATION_CONTROLS: ConversationControlAvailability =
  Object.freeze({
    activate: false,
    add: false,
    close: false,
    composer: false,
    hasSession: false,
    history: false,
    model: false,
    reasoning: false,
    restart: false,
    send: false,
    stop: false,
    tabNavigation: false,
  });

interface PendingPermission {
  card: HTMLElement;
  resolve: (response: RequestPermissionResponse) => void;
  tabId: string;
}

function rejectionFor(options: PermissionOption[]): RequestPermissionResponse {
  const rejectOption = options.find(
    (option) => option.kind === "reject_once" || option.kind === "reject_always",
  );
  return rejectOption
    ? {
        outcome: {
          outcome: "selected",
          optionId: rejectOption.optionId,
        },
      }
    : { outcome: { outcome: "cancelled" } };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Could not read the pasted image"));
    });
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not decode the pasted image"));
        return;
      }
      resolve(reader.result);
    });
    reader.readAsDataURL(file);
  });
}

export class HermesianSidebarView extends ItemView {
  private addConversationButtonEl!: HTMLButtonElement;
  private composerEl!: HTMLTextAreaElement;
  private composerSlashToken: ComposerSlashToken | null = null;
  private conversationTabsEl!: HTMLElement;
  private conversationWorkspace: PersistedConversationWorkspace | undefined;
  private controller: ConversationController<HermesAcpClient> | undefined;
  private controllerUnsubscribe: (() => void) | undefined;
  private contextProgressEl!: HTMLElement;
  private contextUsageEl!: HTMLElement;
  private currentFileBarEl!: HTMLButtonElement;
  private currentFileLabelEl!: HTMLElement;
  private currentFilePath: string | undefined;
  private includeCurrentDocumentContext = true;
  private historyButtonEl!: HTMLButtonElement;
  private imageAttachmentBarEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private modelButtonEl!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private modelPicker: HermesModelPickerPopover | null = null;
  private pendingSelection: SelectionContext | undefined;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly loadedMessageTabIds = new Set<string>();
  private messageRenderer!: MessageRenderer;
  private turnManager!: TurnManager;
  private readonly editScopes = new Map<
    string,
    SelectionContext | MarkdownDocumentContext | undefined
  >();
  private readonly pendingImages = new Map<string, PastedImageAttachment[]>();
  private reasoningButtonEl!: HTMLButtonElement;
  private reasoningLabelEl!: HTMLElement;
  private selectionBarEl!: HTMLElement;
  private sendButtonEl!: HTMLButtonElement;
  private slashMenuEl!: HTMLElement;
  private slashTokenEl!: HTMLElement;
  private slashTokenIconEl!: HTMLElement;
  private slashTokenLabelEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private readonly tabSelections = new Map<string, SelectionContext | undefined>();
  private slashMenuIndex = 0;
  private slashMenuItems: SlashMenuItem[] = [];
  private statusEl!: HTMLElement;
  private startup: ViewStartupCoordinator | undefined;
  private startupStatusClickBound = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HermesianPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HERMESIAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Hermesian";
  }

  getIcon(): string {
    return HERMESIAN_ICON_ID;
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    this.updateControls(true, false);
    this.plugin.attachView(this);
    this.bindStartupStatusRetry();
    this.ensureConversationController();
    this.startup = new ViewStartupCoordinator({
      isLayoutReady: () => this.app.workspace.layoutReady,
      whenLayoutReady: (callback) => {
        this.app.workspace.onLayoutReady(callback);
      },
      startInitialization: () => this.startBackgroundInitialization(),
      onFailure: (error) => {
        this.handleStartupFailure(error);
      },
      onStatus: (status, detail) => {
        this.applyStartupStatus(status, detail);
      },
    });
    // Must return immediately so Obsidian layout restore is never blocked on ACP.
    this.startup.begin();
  }

  async onClose(): Promise<void> {
    this.modelPicker?.detach();
    this.modelPicker = null;
    this.startup?.close();
    this.startup = undefined;
    this.captureActiveConversationRuntime();
    await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    for (const [permissionId, permission] of this.permissions) {
      this.controller?.completePermission(permissionId);
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    this.controllerUnsubscribe?.();
    this.controllerUnsubscribe = undefined;
    await this.controller?.shutdown();
    this.controller = undefined;
    await this.plugin.releaseView(this);
  }

  setSelection(context: SelectionContext): void {
    this.pendingSelection = context;
    const activeTabId = this.conversationWorkspace?.activeTabId;
    if (activeTabId) {
      this.tabSelections.set(activeTabId, context);
    }
    this.setCurrentFile(context.filePath);
    this.renderSelectionBar();
    this.composerEl.focus();
  }

  setCurrentFile(filePath: string | undefined): void {
    this.currentFilePath = filePath;
    if (this.currentFileLabelEl) {
      this.renderCurrentFile();
    }
  }

  handleHermesEvent(tabId: string, event: HermesUiEvent): void {
    switch (event.type) {
      case "status":
        if (this.conversationWorkspace && this.conversationWorkspace.activeTabId !== tabId) {
          return;
        }
        this.statusEl.setText(
          event.status === "connected"
            ? "Connected"
            : event.status === "connecting"
              ? "Connecting…"
              : event.status === "error"
                ? "Connection error"
                : "Disconnected",
        );
        this.statusEl.dataset.status = event.status;
        this.statusEl.setAttribute("aria-label", event.detail ?? event.status);
        return;
      case "assistant-delta":
        this.appendAssistantDelta(tabId, event.text);
        return;
      case "thought-delta":
        this.appendThoughtDelta(tabId, event.text);
        return;
      case "tool":
        this.renderToolEvent(tabId, event);
        return;
      case "notice":
        this.appendSystemMessage(event.text, false, tabId);
        return;
      case "error":
        this.appendSystemMessage(`Error: ${event.message}`, true, tabId);
        if (hermesEventEndsTurn(event)) {
          this.editScopes.set(tabId, undefined);
          void this.finishFailedTurn(tabId);
        }
        return;
      case "turn-stop":
        this.editScopes.set(tabId, undefined);
        void this.finishTurn(tabId, event.reason);
        return;
    }
  }

  handleHermesSessionState(tabId: string, state: HermesSessionState): void {
    this.controller?.updateClientState(tabId, state);
    if (!this.conversationWorkspace || this.conversationWorkspace.activeTabId === tabId) {
      this.renderSessionState(state);
    }
  }

  getAggregateConversationControls():
    | ConversationAggregateControlAvailability
    | undefined {
    return this.controller?.getSnapshot().controls.aggregate;
  }

  requestPermission(
    tabId: string,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const permissionId = `${tabId}:${request.toolCall.toolCallId}`;
    this.controller?.beginPermission(tabId, permissionId);
    this.revealActiveTurnForPermission(tabId);
    const diffs = (request.toolCall.content ?? [])
      .filter(
        (content): content is Extract<ToolCallContent, { type: "diff" }> =>
          content.type === "diff",
      )
      .map((content) => ({
        newText: content.newText,
        oldText: content.oldText,
        path: content.path,
      }));
    if (request.toolCall.kind === "edit" || diffs.length > 0) {
      const validation = validateSelectionEdit(this.editScopes.get(tabId), diffs);
      if (validation.allowed === false) {
        this.appendSystemMessage(`Blocked edit: ${validation.reason}`, true, tabId);
        this.controller?.completePermission(permissionId);
        return Promise.resolve(rejectionFor(request.options));
      }
    }
    try {
      const automatic = this.plugin.automaticPermissionResponse(request);
      if (automatic) {
        this.controller?.completePermission(permissionId);
        return Promise.resolve(automatic);
      }
    } catch (error) {
      this.appendSystemMessage(
        `Blocked edit outside vault: ${this.messageFor(error)}`,
        true,
        tabId,
      );
      this.controller?.completePermission(permissionId);
      return Promise.resolve(rejectionFor(request.options));
    }
    if (signal.aborted) {
      this.controller?.completePermission(permissionId);
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      const card = this.ensureTurnActivity(tabId).createDiv({ cls: "hermesian-permission" });
      const heading = card.createDiv({ cls: "hermesian-permission-heading" });
      const icon = heading.createSpan();
      setIcon(icon, request.toolCall.kind === "edit" ? "file-pen-line" : "shield-alert");
      heading.createSpan({
        text: request.toolCall.title ?? "Hermes requests permission",
      });

      const contents = request.toolCall.content ?? [];
      this.renderPermissionContents(card, contents);

      const actions = card.createDiv({ cls: "hermesian-permission-actions" });
      const finish = (response: RequestPermissionResponse): void => {
        if (!this.permissions.has(permissionId)) {
          return;
        }
        this.permissions.delete(permissionId);
        this.controller?.completePermission(permissionId);
        this.renderAddConversationControl();
        this.renderConversationTabs();
        actions.querySelectorAll("button").forEach((button: Element) => {
          (button as HTMLButtonElement).disabled = true;
        });
        card.addClass("is-resolved");
        resolve(response);
      };

      for (const option of request.options) {
        this.addPermissionButton(actions, option, finish);
      }

      this.permissions.set(permissionId, { card, resolve, tabId });
      this.renderAddConversationControl();
      this.renderConversationTabs();
      const onAbort = (): void => {
        finish({ outcome: { outcome: "cancelled" } });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
      this.scrollToBottom(tabId);
    });
  }

  private renderShell(): void {
    const callbacks: SidebarShellCallbacks = {
      onAddConversation: () => {
        void this.addConversation();
      },
      onMessagesClick: (event: MouseEvent) => {
        this.openRenderedLink(event);
      },
      onOpenHistory: () => {
        void this.openHistoryPicker();
      },
    };

    const shell = createSidebarShell(this.containerEl, callbacks);
    this.statusEl = shell.statusEl;
    this.addConversationButtonEl = shell.addConversationButtonEl;
    this.historyButtonEl = shell.historyButtonEl;
    this.conversationTabsEl = shell.conversationTabsEl;
    this.messagesEl = shell.messagesEl;
    this.messageRenderer = new MessageRenderer(this.messagesEl);

    const turnCallbacks: TurnCallbacks = {
      onTurnComplete: (_tabId: string) => {
        this.renderConversationTabs();
        if (this.conversationWorkspace?.activeTabId === _tabId) {
          this.updateControls(false);
        }
      },
    };
    this.turnManager = new TurnManager(this.messageRenderer, turnCallbacks);

    // Wire icons (needs Obsidian's setIcon)
    setIcon(shell.root.querySelector(".hermesian-logo")!, HERMESIAN_ICON_ID);
    setIcon(shell.addConversationButtonEl, "square-plus");
    setIcon(shell.historyButtonEl, "history");

    this.appendSystemMessage(
      "Select text in a Markdown note, run 'Ask Hermes about selection', then describe the change you want.",
    );

    const composerCallbacks: ComposerCallbacks = {
      onDraftChange: (_draft: string) => {
        this.renderSlashMenu(true);
        this.captureActiveConversationRuntime();
      },
      onPaste: (event: ClipboardEvent) => {
        void this.handleComposerPaste(event);
      },
      onSend: () => {
        void this.sendMessage();
      },
      onStop: () => {
        const activeTab = this.activeConversationTab();
        if (activeTab) {
          void this.plugin.getClient(activeTab.id).cancel();
        }
      },
      onSlashTokenClear: () => {
        this.setComposerSlashToken(null);
        this.composerEl.value = "";
        this.captureActiveConversationRuntime();
        this.renderSlashMenu(true);
        this.composerEl.focus();
      },
    };

    const initialComposerState: ComposerState = {
      disabled: true,
      draft: "",
      placeholder: "Ask Hermes…  ↵ to send · Shift+↵ for new line",
      sendEnabled: false,
      stopVisible: false,
    };

    const composerElements = createComposerView(
      shell.root,
      initialComposerState,
      composerCallbacks,
    );
    this.currentFileBarEl = composerElements.currentFileBarEl;
    this.currentFileLabelEl = composerElements.currentFileLabelEl;
    this.selectionBarEl = composerElements.selectionBarEl;
    this.imageAttachmentBarEl = composerElements.imageAttachmentBarEl;
    this.composerEl = composerElements.composerEl;
    this.slashMenuEl = composerElements.slashMenuEl;
    this.slashTokenEl = composerElements.slashTokenEl;
    this.slashTokenIconEl = composerElements.slashTokenIconEl;
    this.slashTokenLabelEl = composerElements.slashTokenLabelEl;
    this.modelButtonEl = composerElements.modelButtonEl;
    this.modelLabelEl = composerElements.modelLabelEl;
    this.reasoningButtonEl = composerElements.reasoningButtonEl;
    this.reasoningLabelEl = composerElements.reasoningLabelEl;
    this.sendButtonEl = composerElements.sendButtonEl;
    this.stopButtonEl = composerElements.stopButtonEl;
    this.contextProgressEl = composerElements.contextProgressEl;
    this.contextUsageEl = composerElements.contextUsageEl;

    // Wire icons (needs Obsidian's setIcon)
    setIcon(composerElements.currentFileBarEl.querySelector(".hermesian-current-file-icon")!, "file-text");
    setIcon(composerElements.modelButtonEl.querySelector(".hermesian-model-icon")!, "bot");
    setIcon(composerElements.modelButtonEl.querySelector(".hermesian-model-chevron")!, "chevron-down");
    setIcon(composerElements.reasoningButtonEl.querySelector(".hermesian-reasoning-icon")!, "brain");
    setIcon(composerElements.addSelectionButtonEl.querySelector("span")!, "paperclip");
    setIcon(composerElements.sendButtonEl.querySelector("span")!, "arrow-right");
    setIcon(composerElements.stopButtonEl.querySelector("span")!, "square");
    this.setComposerSlashToken(null);

    // Wire event handlers
    this.currentFileBarEl.addEventListener("click", () => {
      if (!this.currentFilePath) {
        return;
      }
      this.includeCurrentDocumentContext = !this.includeCurrentDocumentContext;
      this.renderCurrentFile();
      this.captureActiveConversationRuntime();
    });
    this.renderCurrentFile();

    this.composerEl.addEventListener("keydown", (event) => {
      if (this.handleSlashMenuKeydown(event)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.composerEl.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!this.slashMenuEl.contains(this.containerEl.ownerDocument.activeElement)) {
          this.hideSlashMenu();
        }
      }, 0);
    });

    this.modelButtonEl.addEventListener("click", () => this.openModelPicker());
    this.renderReasoningButton();
    this.reasoningButtonEl.addEventListener("click", () => {
      void this.openReasoningPicker();
    });

    let selectionSource: MarkdownView | undefined;
    let renderedSelection = "";
    composerElements.addSelectionButtonEl.addEventListener("pointerdown", (event) => {
      selectionSource =
        this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
      renderedSelection =
        this.containerEl.ownerDocument.getSelection()?.toString() ?? "";
      event.preventDefault();
    });
    composerElements.addSelectionButtonEl.addEventListener("click", () => {
      const source = selectionSource;
      const selectedText = renderedSelection;
      selectionSource = undefined;
      renderedSelection = "";
      void this.plugin.captureAndAttachSelection(source, selectedText);
    });
  }

  private async initializeConversationWorkspace(
    result: ConversationInitializationResult,
  ): Promise<void> {
    this.conversationWorkspace = result.workspace;
    this.showConversationMessages(result.tabId);
    this.renderConversationTabs();

    if (result.items) {
      await this.renderHistorySession(
        { cwd: "", sessionId: result.sessionId },
        result.items,
        false,
      );
    } else if (result.started) {
      this.resetConversationView(result.tabId);
      this.loadedMessageTabIds.add(result.tabId);
      this.appendSystemMessage(
        result.replaced
          ? "The saved Hermes session could not be restored. A new session was started for this tab."
          : "New Hermes conversation started.",
        result.replaced,
      );
    }

    this.restoreActiveConversationRuntime();
    this.renderConversationTabs();
  }

  private ensureConversationController(): void {
    if (this.controller) {
      return;
    }
    this.controller = new ConversationController(
      this.plugin.getConversationControllerDependencies(),
    );
    this.controllerUnsubscribe = this.controller.subscribe((snapshot) => {
      this.handleControllerSnapshot(snapshot);
    });
  }

  private async startBackgroundInitialization(): Promise<void> {
    if (this.startup?.isClosed()) {
      return;
    }
    this.ensureConversationController();
    if (!this.controller) {
      throw new Error("Conversation controller is unavailable");
    }
    const result = await this.controller.initialize();
    if (this.startup?.isClosed()) {
      return;
    }
    await this.initializeConversationWorkspace(result);
  }

  private handleStartupFailure(error: unknown): void {
    if (this.startup?.isClosed()) {
      return;
    }
    const message = this.messageFor(error);
    new Notice(`Hermesian connection failed: ${message}`);
    this.appendSystemMessage(
      `Connection failed: ${message}. Click the status badge to retry.`,
      true,
    );
    this.updateControls(false);
  }

  private applyStartupStatus(
    status: "connecting" | "ready" | "error" | "disconnected",
    detail?: string,
  ): void {
    if (!this.statusEl || this.startup?.isClosed()) {
      return;
    }
    if (status === "connecting") {
      this.statusEl.setText("Connecting…");
      this.statusEl.dataset.status = "connecting";
      this.statusEl.setAttribute("aria-label", detail ?? "Connecting to Hermes");
      this.statusEl.classList.add("is-clickable");
      this.statusEl.title = "Connecting to Hermes";
      return;
    }
    if (status === "error") {
      this.statusEl.setText("Retry connection");
      this.statusEl.dataset.status = "error";
      this.statusEl.setAttribute(
        "aria-label",
        detail ? `Connection error: ${detail}. Click to retry.` : "Connection error. Click to retry.",
      );
      this.statusEl.classList.add("is-clickable");
      this.statusEl.title = "Click to retry Hermes connection";
      return;
    }
    if (status === "ready") {
      // Live ACP status events will refine this; keep a non-blocking default.
      if (this.statusEl.dataset.status === "connecting") {
        this.statusEl.setText("Connected");
        this.statusEl.dataset.status = "connected";
        this.statusEl.setAttribute("aria-label", "Connected");
      }
      this.statusEl.classList.remove("is-clickable");
      this.statusEl.title = "";
      return;
    }
    this.statusEl.setText("Disconnected");
    this.statusEl.dataset.status = "disconnected";
    this.statusEl.setAttribute("aria-label", detail ?? "Disconnected");
  }

  private bindStartupStatusRetry(): void {
    if (this.startupStatusClickBound || !this.statusEl) {
      return;
    }
    this.startupStatusClickBound = true;
    this.statusEl.addEventListener("click", () => {
      if (this.startup?.getPhase() !== "failed") {
        return;
      }
      void this.prepareStartupRetry().then(() => {
        if (!this.startup || this.startup.isClosed()) {
          return;
        }
        this.applyStartupStatus("connecting");
        this.startup.retry();
      });
    });
  }

  private async prepareStartupRetry(): Promise<void> {
    // controller.initialize() caches the first promise; rebuild after failure.
    this.controllerUnsubscribe?.();
    this.controllerUnsubscribe = undefined;
    await this.controller?.shutdown();
    this.controller = undefined;
    this.ensureConversationController();
  }

  private handleControllerSnapshot(
    snapshot: ConversationControllerSnapshot,
  ): void {
    if (snapshot.workspace) {
      this.conversationWorkspace = snapshot.workspace;
    }
    if (this.sendButtonEl) {
      this.updateControls(
        snapshot.initializing || snapshot.globalOperation !== "idle",
      );
    }
  }

  private activeConversationTab(): PersistedConversationTab | undefined {
    return this.conversationWorkspace?.tabs.find(
      (tab) => tab.id === this.conversationWorkspace?.activeTabId,
    );
  }

  private turnRuntime(tabId: string) {
    return this.turnManager.ensure(tabId);
  }

  private isTabBusy(tabId: string): boolean {
    return (
      this.controller?.getSnapshot().tabOperations.get(tabId)?.prompt === "running" ||
      this.turnManager.isBusy(tabId) ||
      this.plugin.peekClient(tabId)?.isBusy === true
    );
  }

  private isTabLoading(tabId: string): boolean {
    return this.controller?.getSnapshot().tabOperations.get(tabId)?.connection === "loading";
  }

  private isTabClosing(tabId: string): boolean {
    return this.controller?.getSnapshot().tabOperations.get(tabId)?.closing === true;
  }

  private hasPendingPermission(tabId: string): boolean {
    return this.controller?.getSnapshot().tabOperations.get(tabId)?.permissionPending === true;
  }


  private activeSessionState(): HermesSessionState {
    const activeTab = this.activeConversationTab();
    return (
      (activeTab && this.controller?.getSnapshot().sessionStates.get(activeTab.id)) ??
      (activeTab ? this.plugin.peekClient(activeTab.id)?.currentSessionState : undefined) ??
      {
        catalogLoading: false,
        commands: [],
        models: [],
        skillCatalogLoading: false,
        skills: [],
        switchingModel: false,
      }
    );
  }

  private controlAvailability() {
    return this.controller?.getSnapshot().controls.active ?? DISABLED_CONVERSATION_CONTROLS;
  }

  private tabControlAvailability(tabId: string) {
    return (
      this.controller?.getSnapshot().controls.byTab.get(tabId) ??
      DISABLED_CONVERSATION_CONTROLS
    );
  }

  private async ensureClientForTab(
    tabId: string,
  ): Promise<{
    items?: HermesHistoryItem[];
    replaced: boolean;
    sessionId: string;
    started: boolean;
  }> {
    if (!this.controller) {
      throw new Error("Conversation controller is unavailable");
    }
    const result = await this.controller.ensureClientForTab(tabId);
    this.conversationWorkspace = result.workspace;
    return result;
  }

  private showConversationMessages(tabId: string): void {
    this.messageRenderer.show(tabId);
  }

  private forgetConversationMessages(tabId: string): void {
    this.loadedMessageTabIds.delete(tabId);
    this.messageRenderer.forget(tabId);
  }

  private async revealActiveTurnForPermission(tabId: string): Promise<void> {
    const workspace = this.conversationWorkspace;
    if (!workspace || !this.controller) {
      return;
    }
    if (workspace.activeTabId === tabId) {
      return;
    }
    this.captureActiveConversationRuntime();
    try {
      const result = await this.controller.revealForPermission(
        tabId,
        `${tabId}:${this.permissions.size}`,
      );
      this.conversationWorkspace = result.workspace;
      this.showConversationMessages(tabId);
      this.restoreActiveConversationRuntime();
      this.renderSessionState(
        this.controller.getSnapshot().sessionStates.get(tabId) ??
          this.plugin.getClient(tabId).currentSessionState,
      );
      this.renderConversationTabs();
      this.updateControls(false);
    } catch (error) {
      if (
        error instanceof ConversationControllerError &&
        (error.code === "cancelled" || error.code === "operation_stale")
      ) {
        return;
      }
      new Notice(`Hermesian could not reveal this conversation: ${this.messageFor(error)}`);
    }
  }

  private captureActiveConversationRuntime(): void {
    const workspace = this.conversationWorkspace;
    if (!workspace) {
      return;
    }
    const activeTabId = workspace.activeTabId;
    this.tabSelections.set(activeTabId, this.pendingSelection);
    this.conversationWorkspace = updateConversationTab(workspace, activeTabId, {
      draft: this.getComposerCanonicalDraft(),
      includeCurrentDocumentContext: this.includeCurrentDocumentContext,
      token: this.composerSlashToken ?? undefined,
    });
    this.plugin.setConversationWorkspace(this.conversationWorkspace);
  }

  private restoreActiveConversationRuntime(): void {
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    this.applyComposerCanonicalDraft(activeTab.draft, activeTab.token);
    this.includeCurrentDocumentContext = activeTab.includeCurrentDocumentContext;
    this.pendingSelection = this.tabSelections.get(activeTab.id);
    this.renderCurrentFile();
    this.renderSelectionBar();
    this.renderImageAttachmentBar();
    this.hideSlashMenu();
  }

  private renderConversationTabs(): void {
    if (!this.conversationTabsEl) {
      return;
    }
    const workspace = this.conversationWorkspace;
    if (!workspace) {
      this.conversationTabsEl.empty();
      return;
    }
    const callbacks: ConversationTabsCallbacks = {
      onActivate: (tabId) => { void this.switchConversation(tabId); },
      onClose: (tabId) => { void this.closeConversation(tabId); },
    };
    renderConversationTabsView(this.conversationTabsEl, {
      activeTabId: workspace.activeTabId,
      isTabBusy: (tabId) => this.isTabBusy(tabId),
      isTabLoading: (tabId) => this.isTabLoading(tabId),
      tabNavigationDisabled: !this.controlAvailability().tabNavigation,
      tabs: workspace.tabs,
    }, callbacks);
  }

  private async addConversation(): Promise<void> {
    if (
      !this.controller ||
      !this.controlAvailability().add ||
      this.isTabClosing(this.activeConversationTab()?.id ?? "") ||
      this.activeSessionState().switchingModel
    ) {
      return;
    }
    this.captureActiveConversationRuntime();
    const existingTabIds = new Set(
      this.conversationWorkspace?.tabs.map((tab) => tab.id) ?? [],
    );
    const adding = this.controller.addConversation();
    const pendingWorkspace = this.controller.getSnapshot().workspace;
    const pendingTabId = pendingWorkspace?.activeTabId;
    if (pendingTabId && !existingTabIds.has(pendingTabId)) {
      this.pendingSelection = undefined;
      this.tabSelections.set(pendingTabId, undefined);
      this.showConversationMessages(pendingTabId);
      this.resetConversationView(pendingTabId);
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
      this.appendSystemMessage(
        "Starting a new Hermes conversation…",
        false,
        pendingTabId,
      );
    }

    try {
      const result = await adding;
      this.conversationWorkspace = result.workspace;
      this.loadedMessageTabIds.add(result.tabId);
      if (result.workspace.activeTabId === result.tabId) {
        this.showConversationMessages(result.tabId);
        this.resetConversationView(result.tabId);
        this.restoreActiveConversationRuntime();
      }
      this.renderConversationTabs();
      this.appendSystemMessage(
        "New Hermes conversation started.",
        false,
        result.tabId,
      );
    } catch (error) {
      new Notice(`Hermesian could not add a conversation: ${this.messageFor(error)}`);
    }
  }

  private async closeConversation(tabId: string): Promise<void> {
    const workspace = this.conversationWorkspace;
    if (
      !this.controller ||
      !workspace ||
      !workspace.tabs.some((tab) => tab.id === tabId) ||
      !this.tabControlAvailability(tabId).close ||
      this.isTabClosing(tabId) ||
      this.isTabBusy(tabId) ||
      this.hasPendingPermission(tabId) ||
      this.controller?.getSnapshot().sessionStates.get(tabId)?.switchingModel
    ) {
      return;
    }

    this.captureActiveConversationRuntime();
    this.updateControls(true);
    try {
      const result = await this.controller.closeConversation(tabId);
      this.conversationWorkspace = result.workspace;
      this.tabSelections.delete(tabId);
      this.pendingImages.delete(tabId);
      this.forgetConversationMessages(tabId);
      this.turnManager.delete(tabId);

      const activeTabId = result.workspace.activeTabId;
      this.showConversationMessages(activeTabId);
      // Start owner-scoped hydration for the replacement when needed
      if (result.replacementTabId) {
        this.showConversationMessages(result.replacementTabId);
        this.appendSystemMessage(
          "Conversation closed. A new Hermes conversation started.",
          false,
          result.replacementTabId,
        );
        this.startConversationHydration(result.replacementTabId);
      } else if (activeTabId) {
        const tabOp = this.controller.getSnapshot().tabOperations.get(activeTabId);
        if (tabOp && tabOp.connection !== "ready" && tabOp.connection !== "loading") {
          this.startConversationHydration(activeTabId);
        }
      }
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
    } catch (error) {
      if (
        error instanceof ConversationControllerError &&
        (error.code === "cancelled" || error.code === "operation_stale")
      ) {
        return;
      }
      new Notice(`Hermesian could not close that conversation: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private startConversationHydration(tabId: string): void {
    if (!this.controller) {
      return;
    }
    const ownerId = tabId;
    this.controller
      .ensureConversationReady(ownerId)
      .then((result) => {
        const snapshot = this.controller?.getSnapshot();
        if (!snapshot || !snapshot.workspace?.tabs.some((t) => t.id === ownerId)) {
          return; // owner was removed
        }
        if (result.items && result.sessionId && !result.started) {
          void this.renderHistorySession(
            { cwd: "", sessionId: result.sessionId },
            result.items,
            false,
            ownerId,
          );
          this.loadedMessageTabIds.add(ownerId);
        } else if (result.started) {
          this.resetConversationView(ownerId);
          this.loadedMessageTabIds.add(ownerId);
          this.appendSystemMessage(
            "New Hermes conversation started.",
            false,
            ownerId,
          );
        }
        const activeNow = snapshot.workspace?.activeTabId;
        if (activeNow === ownerId) {
          this.showConversationMessages(ownerId);
        }
        this.restoreActiveConversationRuntime();
        this.renderConversationTabs();
      })
      .catch((_error) => {
        const snapshot = this.controller?.getSnapshot();
        if (
          snapshot &&
          snapshot.workspace?.tabs.some((t) => t.id === ownerId) &&
          snapshot.tabOperations.get(ownerId)?.connection === "failed"
        ) {
          this.appendSystemMessage(
            `Unable to load this conversation. Select the tab to retry.`,
            false,
            ownerId,
          );
        }
      });
  }

  private async switchConversation(tabId: string): Promise<void> {
    if (
      !this.controller ||
      !this.controlAvailability().tabNavigation ||
      this.isTabClosing(tabId)
    ) {
      return;
    }

    this.captureActiveConversationRuntime();
    try {
      // Fast path: if switching to already-active tab that needs hydration
      const activeTabId = this.controller?.getSnapshot().workspace?.activeTabId;
      if (activeTabId === tabId) {
        const tabOp = this.controller?.getSnapshot().tabOperations.get(tabId);
        if (tabOp && tabOp.connection !== "ready" && tabOp.connection !== "loading") {
          this.startConversationHydration(tabId);
          return;
        }
        if (tabOp?.connection === "ready" || tabOp?.connection === "loading") {
          return; // already active (ready or still initializing)
        }
      }
      const result = await this.controller.switchConversation(tabId);
      this.conversationWorkspace = result.workspace;
      if (result.items && result.sessionId) {
        await this.renderHistorySession(
          { cwd: "", sessionId: result.sessionId },
          result.items,
          false,
          result.tabId,
        );
      } else if (result.started) {
        this.resetConversationView(result.tabId);
        this.loadedMessageTabIds.add(result.tabId);
        this.appendSystemMessage(
          "New Hermes conversation started.",
          false,
          result.tabId,
        );
      }
      this.showConversationMessages(result.tabId);
      this.restoreActiveConversationRuntime();
      this.renderSessionState(
        this.controller?.getSnapshot().sessionStates.get(result.tabId) ?? this.plugin.getClient(result.tabId).currentSessionState,
      );
      this.renderConversationTabs();
    } catch (error) {
      if (
        error instanceof ConversationControllerError &&
        (error.code === "cancelled" || error.code === "operation_stale")
      ) {
        return;
      }
      new Notice(`Hermesian could not switch conversations: ${this.messageFor(error)}`);
    }
  }

  private openModelPicker(): void {
    const state = this.activeSessionState();
    const activeTab = this.activeConversationTab();
    if (!activeTab || this.modelButtonEl.disabled || state.models.length === 0) {
      return;
    }
    if (this.modelPicker) {
      // Repeat click on the model button toggles the popover closed.
      this.modelPicker.detach();
      return;
    }
    const targetTabId = activeTab.id;
    let settled = false;
    this.modelPicker = new HermesModelPickerPopover({
      anchorEl: this.modelButtonEl,
      models: state.models,
      hiddenSwitchIds: this.plugin.settings.hiddenModelSwitchIds,
      currentSwitchId: state.currentModel?.switchId,
      iconRenderer: (element, icon) => setIcon(element, icon),
      onChoose: (model) => {
        if (settled) {
          return;
        }
        settled = true;
        void this.chooseModel(targetTabId, model);
      },
      onClose: () => {
        this.modelPicker = null;
      },
      onSaveHidden: (switchIds) => this.plugin.saveHiddenModelSwitchIds(switchIds),
    });
    this.modelPicker.open();
  }

  private async chooseModel(tabId: string, model: HermesModelOption): Promise<void> {
    if (this.isTabBusy(tabId)) {
      return;
    }
    try {
      await this.plugin.getClient(tabId).setModel(model);
    } catch (error) {
      new Notice(`Hermesian model switch failed: ${this.messageFor(error)}`);
    }
  }

  private async openHistoryPicker(): Promise<void> {
    if (this.historyButtonEl.disabled) {
      return;
    }
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    this.updateControls(false);
    try {
      const sessions = await this.plugin.getClient(activeTab.id).listSessions();
      if (sessions.length === 0) {
        new Notice("No unarchived Hermes sessions were found in the current profile.");
        return;
      }
      new HermesHistorySuggestModal(this.app, sessions, (session) => {
        void this.chooseHistorySession(session);
      }).open();
    } catch (error) {
      new Notice(`Hermesian history failed: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private async chooseHistorySession(
    session: HermesHistoryEntry,
  ): Promise<void> {
    const workspace = this.conversationWorkspace;
    if (
      !this.controller ||
      !workspace
    ) {
      return;
    }
    this.captureActiveConversationRuntime();
    this.updateControls(false);
    try {
      const result = await this.controller.openHistorySession(session.sessionId);
      this.conversationWorkspace = result.workspace;

      if (result.reused) {
        this.showConversationMessages(result.tabId);
        this.restoreActiveConversationRuntime();
        this.renderConversationTabs();
        const owner = result.workspace.tabs.find((tab) => tab.id === result.tabId);
        new Notice(
          `That Hermes session is already open in conversation ${owner?.label ?? result.tabId}.`,
        );
        return;
      }

      this.loadedMessageTabIds.add(result.tabId);
      if (result.items) {
        await this.renderHistorySession(session, result.items, true, result.tabId);
      }
      this.editScopes.set(result.tabId, undefined);
      this.showConversationMessages(result.tabId);
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
    } catch (error) {
      if (error instanceof ConversationControllerError && error.code === "session_reserved") {
        new Notice("That Hermes session is already opening in another conversation.");
        return;
      }
      new Notice(`Hermesian could not load that session: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private async renderHistorySession(
    session: HermesHistoryEntry,
    items: HermesHistoryItem[],
    announce = true,
    tabId = this.conversationWorkspace?.activeTabId,
  ): Promise<void> {
    if (!tabId) {
      return;
    }
    this.resetConversationView(tabId);
    if (announce) {
      this.appendSystemMessage(
        `Resumed historical session: ${session.title || session.sessionId}`,
        false,
        tabId,
      );
    }

    let turnItems: HermesHistoryItem[] = [];
    const flushTurn = async (): Promise<void> => {
      if (turnItems.length === 0) {
        return;
      }
      await this.renderHistoryTurn(turnItems, tabId);
      turnItems = [];
    };
    for (const item of items) {
      if (item.kind === "user") {
        await flushTurn();
        this.appendUserMessage(item.text, undefined, undefined, tabId);
      } else {
        turnItems.push(item);
      }
    }
    await flushTurn();
    if (items.length === 0) {
      this.appendSystemMessage("This session has no displayable messages.", false, tabId);
    }
    this.loadedMessageTabIds.add(tabId);
    this.updateComposerPlaceholder();
    this.scrollToBottom(tabId);
  }

  private async renderHistoryTurn(
    items: HermesHistoryItem[],
    tabId: string,
  ): Promise<void> {
    const turn = this.messageContainer(tabId).createDiv({ cls: "hermesian-turn" });
    const activity = turn.createDiv({ cls: "hermesian-turn-activity" });
    let assistantText = "";
    for (const item of items) {
      if (item.kind === "assistant") {
        assistantText += item.text;
      } else if (item.kind === "thought") {
        const details = activity.createEl("details", { cls: "hermesian-thought" });
        details.createEl("summary", { text: "Thinking" });
        details.createEl("pre", { text: item.text });
      } else if (item.kind === "tool") {
        const tool = activity.createDiv({ cls: "hermesian-tool" });
        const icon = tool.createSpan();
        setIcon(icon, "wrench");
        tool.createSpan({ text: item.title, cls: "hermesian-tool-title" });
        tool.createSpan({ text: item.status ?? "completed", cls: "hermesian-tool-status" });
      }
    }
    if (activity.childElementCount === 0) {
      activity.remove();
    }
    if (assistantText) {
      const message = turn.createDiv({ cls: "hermesian-message is-assistant" });
      const content = message.createDiv({ cls: "hermesian-message-content" });
      await this.renderMarkdown(content, assistantText);
    }
  }

  private openReasoningPicker(): void {
    if (this.reasoningButtonEl.disabled) {
      return;
    }
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    const targetTabId = activeTab.id;
    let settled = false;

    new HermesReasoningSuggestModal(
      this.app,
      this.plugin.getReasoningEffort(),
      (effort) => {
        if (settled) {
          return;
        }
        settled = true;
        void this.chooseReasoningEffort(targetTabId, effort);
      },
    ).open();
  }

  private async chooseReasoningEffort(
    tabId: string,
    effort: ReasoningEffort,
  ): Promise<void> {
    if (effort === this.plugin.getReasoningEffort()) {
      return;
    }
    if (!this.plugin.canApplyConnectionSettings()) {
      return;
    }
    this.captureActiveConversationRuntime();
    this.updateControls(true, false);
    try {
      await this.plugin.setReasoningEffort(tabId, effort);
      await this.ensureClientForTab(tabId);
      this.renderReasoningButton();
      this.appendSystemMessage(
        `Thinking depth set to ${reasoningEffortLabel(effort)}. The current Hermes session was restored.`,
        false,
        tabId,
      );
    } catch (error) {
      new Notice(`Hermesian thinking-depth update failed: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private renderReasoningButton(): void {
    const effort = this.plugin.getReasoningEffort();
    const label = `Thinking: ${reasoningEffortLabel(effort)}`;
    this.reasoningLabelEl.setText(label);
    this.reasoningButtonEl.setAttribute("title", label);
  }

  private renderAddConversationControl(): void {
    this.addConversationButtonEl.disabled = !this.controlAvailability().add;
    this.addConversationButtonEl.setAttribute("title", "Add conversation");
  }

  private renderSessionState(state: HermesSessionState): void {
    const availability = this.controlAvailability();
    this.renderAddConversationControl();
    this.historyButtonEl.disabled = !availability.history;
    this.reasoningButtonEl.disabled = !availability.reasoning;
    this.renderConversationTabs();
    const current = state.currentModel;
    const label = state.switchingModel
      ? "Switching model…"
      : current
        ? `${current.providerName} · ${current.name}`
        : state.catalogLoading
          ? "Loading models…"
          : "Model unavailable";
    this.modelLabelEl.setText(label);
    this.modelButtonEl.disabled = !availability.model || state.models.length === 0;
    this.modelButtonEl.setAttribute(
      "aria-label",
      current ? `Current model: ${current.providerName} ${current.name}` : label,
    );
    this.modelButtonEl.setAttribute("title", label);

    const usageText = formatContextUsage(state.contextUsage);
    this.contextUsageEl.setText(usageText);
    this.contextUsageEl.dataset.level = contextUsageLevel(state.contextUsage);
    this.contextUsageEl.setAttribute(
      "title",
      state.contextUsage
        ? `Hermes estimated context usage: ${state.contextUsage.used.toLocaleString("en-US")} of ${state.contextUsage.size.toLocaleString("en-US")} tokens`
        : "Hermes has not reported context usage for this session yet",
    );
    this.contextProgressEl.dataset.level = contextUsageLevel(state.contextUsage);
    this.contextProgressEl.style.width = `${contextUsagePercent(state.contextUsage)}%`;
    if (this.getComposerCanonicalDraft().startsWith("/")) {
      this.renderSlashMenu(false);
    }
  }

  private renderSlashMenu(resetIndex: boolean): void {
    const value = this.getComposerSlashMenuValue();
    if (
      !this.controlAvailability().composer ||
      this.composerEl.selectionStart !== this.composerEl.value.length ||
      this.composerEl.selectionEnd !== this.composerEl.value.length
    ) {
      this.hideSlashMenu();
      return;
    }

    const previous = this.slashMenuItems[this.slashMenuIndex];
    const state = this.activeSessionState();
    const items = buildSlashMenuItems(
      value,
      state.commands,
      state.skills,
    );
    if (items.length === 0) {
      this.hideSlashMenu();
      return;
    }

    this.slashMenuItems = items;
    this.slashMenuIndex = resetIndex
      ? 0
      : Math.max(
          0,
          previous
            ? items.findIndex(
                (item) => item.kind === previous.kind && item.name === previous.name,
              )
            : 0,
        );
    this.slashMenuEl.empty();
    items.forEach((item, index) => {
      const option = this.slashMenuEl.createEl("button", {
        attr: {
          "aria-selected": "false",
          id: `hermesian-slash-option-${index}`,
          role: "option",
          type: "button",
        },
        cls: "hermesian-slash-option",
      });
      const heading = option.createDiv({ cls: "hermesian-slash-option-heading" });
      heading.createEl("code", { text: `/${item.name}` });
      heading.createSpan({
        text:
          item.kind === "skill"
            ? item.category
              ? `Skill · ${item.category}`
              : "Skill"
            : item.kind === "skill-loader"
              ? "Skills"
              : "Command",
        cls: "hermesian-slash-option-kind",
      });
      option.createDiv({
        text: [item.description, item.inputHint ? `Input: ${item.inputHint}` : ""]
          .filter(Boolean)
          .join(" · "),
        cls: "hermesian-slash-option-description",
      });
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("mouseenter", () => this.setSlashMenuIndex(index));
      option.addEventListener("click", () => this.chooseSlashMenuItem(index));
    });
    this.slashMenuEl.show();
    this.composerEl.setAttribute("aria-expanded", "true");
    this.setSlashMenuIndex(this.slashMenuIndex);
  }

  private setSlashMenuIndex(index: number): void {
    if (this.slashMenuItems.length === 0) {
      return;
    }
    this.slashMenuIndex =
      (index + this.slashMenuItems.length) % this.slashMenuItems.length;
    const options = Array.from(
      this.slashMenuEl.querySelectorAll<HTMLElement>(".hermesian-slash-option"),
    );
    options.forEach((option, optionIndex) => {
      const active = optionIndex === this.slashMenuIndex;
      option.toggleClass("is-active", active);
      option.setAttribute("aria-selected", String(active));
    });
    const active = options[this.slashMenuIndex];
    if (active) {
      this.composerEl.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    }
  }

  private handleSlashMenuKeydown(event: KeyboardEvent): boolean {
    if (this.slashMenuItems.length === 0) {
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.setSlashMenuIndex(
        this.slashMenuIndex + (event.key === "ArrowDown" ? 1 : -1),
      );
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.hideSlashMenu();
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      if (event.isComposing) {
        return false;
      }
      event.preventDefault();
      this.chooseSlashMenuItem(this.slashMenuIndex);
      return true;
    }
    return false;
  }

  private chooseSlashMenuItem(index: number): void {
    const item = this.slashMenuItems[index];
    if (!item) {
      return;
    }
    const token = composerSlashTokenFromMenuItem(item);
    if (token) {
      this.setComposerSlashToken(token);
      this.composerEl.value = "";
      this.composerEl.setSelectionRange(0, 0);
    } else {
      // skill-loader and any non-token items keep plain insertion text
      this.setComposerSlashToken(null);
      const insertion = slashMenuInsertion(item);
      this.composerEl.value = insertion;
      this.composerEl.setSelectionRange(insertion.length, insertion.length);
    }
    this.captureActiveConversationRuntime();
    this.hideSlashMenu();
    this.composerEl.focus();
  }

  private hideSlashMenu(): void {
    this.slashMenuItems = [];
    this.slashMenuIndex = 0;
    this.slashMenuEl.hide();
    this.composerEl.setAttribute("aria-expanded", "false");
    this.composerEl.removeAttribute("aria-activedescendant");
  }

  private renderCurrentFile(): void {
    const label = this.currentFilePath ?? "No Markdown note";
    this.currentFileLabelEl.setText(label);
    this.currentFileBarEl.disabled = !this.currentFilePath;
    this.currentFileBarEl.toggleClass(
      "is-active",
      Boolean(this.currentFilePath && this.includeCurrentDocumentContext),
    );
    this.currentFileBarEl.setAttribute(
      "aria-pressed",
      String(Boolean(this.currentFilePath && this.includeCurrentDocumentContext)),
    );
    this.currentFileBarEl.setAttribute(
      "title",
      this.currentFilePath
        ? `${this.includeCurrentDocumentContext ? "Exclude" : "Include"} ${this.currentFilePath} as context`
        : "Open a Markdown note to use it as context",
    );
    this.currentFileBarEl.dataset.empty = this.currentFilePath ? "false" : "true";
  }

  private async handleComposerPaste(event: ClipboardEvent): Promise<void> {
    const clipboardItems = Array.from(event.clipboardData?.items ?? []);
    const imageItems = clipboardItems.filter(isImageClipboardItem);
    if (imageItems.length === 0) {
      return;
    }

    event.preventDefault();
    const tabId = this.conversationWorkspace?.activeTabId;
    if (!tabId) {
      return;
    }
    const client = this.plugin.peekClient(tabId);
    if (client?.isConnected && !client.supportsImagePrompts) {
      new Notice("The connected Hermes agent does not support image prompts.");
      return;
    }

    const attachments: PastedImageAttachment[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      if (file.size > MAX_PASTED_IMAGE_BYTES) {
        new Notice("Pasted images must be smaller than 10 MB.");
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        attachments.push(
          imageAttachmentFromDataUrl(dataUrl, crypto.randomUUID(), file.type),
        );
      } catch (error) {
        new Notice(`Hermesian could not read the pasted image: ${this.messageFor(error)}`);
      }
    }
    if (attachments.length === 0) {
      return;
    }

    const current = this.pendingImages.get(tabId) ?? [];
    this.pendingImages.set(tabId, [...current, ...attachments].slice(0, 4));
    if (this.conversationWorkspace?.activeTabId === tabId) {
      this.renderImageAttachmentBar();
    }
  }

  private renderImageAttachmentBar(): void {
    const tabId = this.conversationWorkspace?.activeTabId;
    const attachments = tabId ? this.pendingImages.get(tabId) ?? [] : [];
    this.imageAttachmentBarEl.empty();
    if (attachments.length === 0) {
      this.imageAttachmentBarEl.hide();
      return;
    }

    this.imageAttachmentBarEl.show();
    this.imageAttachmentBarEl.createSpan({
      cls: "hermesian-image-attachment-label",
      text: `${attachments.length} image${attachments.length === 1 ? "" : "s"}`,
    });
    for (const attachment of attachments) {
      const item = this.imageAttachmentBarEl.createDiv({
        cls: "hermesian-image-attachment",
      });
      item.createEl("img", {
        attr: {
          alt: "Pasted image",
          src: `data:${attachment.mimeType};base64,${attachment.data}`,
        },
      });
      const remove = item.createEl("button", {
        attr: {
          "aria-label": "Remove pasted image",
          title: "Remove pasted image",
          type: "button",
        },
        cls: "clickable-icon",
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        if (!tabId) {
          return;
        }
        const remaining = (this.pendingImages.get(tabId) ?? []).filter(
          (candidate) => candidate.id !== attachment.id,
        );
        if (remaining.length > 0) {
          this.pendingImages.set(tabId, remaining);
        } else {
          this.pendingImages.delete(tabId);
        }
        this.renderImageAttachmentBar();
      });
    }
  }

  private renderSelectionBar(): void {
    this.selectionBarEl.empty();
    if (!this.pendingSelection) {
      this.selectionBarEl.hide();
      return;
    }

    this.selectionBarEl.show();
    const icon = this.selectionBarEl.createSpan();
    setIcon(icon, "text-select");
    this.selectionBarEl.createSpan({
      text: `${this.pendingSelection.filePath} · L${this.pendingSelection.startLine}–${this.pendingSelection.endLine}`,
    });
    const remove = this.selectionBarEl.createEl("button", {
      attr: { "aria-label": "Remove selection context" },
      cls: "clickable-icon",
    });
    setIcon(remove, "x");
    remove.addEventListener("click", () => {
      this.pendingSelection = undefined;
      this.renderSelectionBar();
      this.captureActiveConversationRuntime();
    });
  }

  private async sendMessage(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (
      !activeTab ||
      !this.controlAvailability().send ||
      this.isTabBusy(activeTab.id) ||
      this.isTabLoading(activeTab.id) ||
      this.hasPendingPermission(activeTab.id)
    ) {
      return;
    }
    if (!activeTab.sessionId) {
      new Notice("This conversation is still starting.");
      return;
    }
    const client = this.plugin.getClient(activeTab.id);
    if (client.sessionId !== activeTab.sessionId) {
      try {
        await this.ensureClientForTab(activeTab.id);
      } catch (error) {
        new Notice(`Hermesian could not prepare this conversation: ${this.messageFor(error)}`);
        return;
      }
    }
    if (
      !isActiveConversationSession(
        this.conversationWorkspace,
        activeTab.id,
        activeTab.sessionId,
      ) ||
      client.sessionId !== activeTab.sessionId
    ) {
      return;
    }
    const rawRequest = this.getComposerCanonicalDraft().trim();
    const isSlashCommand = rawRequest.startsWith("/");
    const pendingImages = isSlashCommand
      ? []
      : this.pendingImages.get(activeTab.id) ?? [];
    if (pendingImages.length > 0 && !client.supportsImagePrompts) {
      new Notice("The connected Hermes agent does not support image prompts.");
      return;
    }
    const request =
      rawRequest ||
      (this.pendingSelection
        ? "请根据上下文改写选中的内容，使其更清晰、严谨，并保留原意。"
        : pendingImages.length > 0
          ? "Please analyze the pasted image and respond to my request."
        : "");
    if (!request) {
      return;
    }

    const selection = isSlashCommand ? undefined : this.pendingSelection;
    const activeFilePath = this.plugin.getCurrentMarkdownFilePath();
    this.setCurrentFile(activeFilePath);
    const documentContext =
      isSlashCommand || selection || !this.includeCurrentDocumentContext
        ? undefined
        : this.plugin.getCurrentDocumentContext();
    if (documentContext) {
      this.setCurrentFile(documentContext.filePath);
    }
    const prompt = selection
      ? buildSelectionPrompt(selection, request)
      : documentContext
        ? buildDocumentPrompt(documentContext, request)
        : isSlashCommand
          ? request
          : buildActiveNotePrompt(activeFilePath, request);
    const runtime = this.turnRuntime(activeTab.id);
    this.editScopes.set(activeTab.id, selection ?? documentContext);
    this.appendUserMessage(request, selection, documentContext, activeTab.id, pendingImages);
    this.setComposerSlashToken(null);
    this.composerEl.value = "";
    this.hideSlashMenu();
    if (!isSlashCommand) {
      this.pendingSelection = undefined;
      this.renderSelectionBar();
    }
    this.pendingImages.delete(activeTab.id);
    this.renderImageAttachmentBar();
    this.captureActiveConversationRuntime();
    this.resetStreamingMessage(activeTab.id);
    runtime.busy = true;
    this.controller?.setPromptRunning(activeTab.id, true);
    runtime.activeTurnEl = this.messageContainer(activeTab.id).createDiv({
      cls: "hermesian-turn",
    });
    this.loadedMessageTabIds.add(activeTab.id);
    this.renderConversationTabs();
    this.updateControls(false);

    try {
      const outboundPrompt = isSlashCommand
        ? buildSlashOutboundPrompt(prompt)
        : `${prompt}\n\n${OBSIDIAN_OUTPUT_RULES}`;
      const promptContent: string | ContentBlock[] = pendingImages.length
        ? buildImagePrompt(outboundPrompt, pendingImages)
        : outboundPrompt;
      await client.sendPrompt(promptContent);
    } catch (error) {
      new Notice(`Hermesian: ${this.messageFor(error)}`);
      if (pendingImages.length > 0) {
        this.pendingImages.set(activeTab.id, pendingImages);
        if (this.conversationWorkspace?.activeTabId === activeTab.id) {
          this.renderImageAttachmentBar();
        }
      }
      this.editScopes.set(activeTab.id, undefined);
      await this.finishFailedTurn(activeTab.id);
    } finally {
      if (runtime.completionPromise) {
        await runtime.completionPromise;
      }
      runtime.busy = false;
      this.controller?.setPromptRunning(activeTab.id, false);
      this.renderConversationTabs();
      if (this.conversationWorkspace?.activeTabId === activeTab.id) {
        this.updateControls(false);
      }
    }
  }

  async startNewSession(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (
      !this.controller ||
      !activeTab ||
      !this.controlAvailability().composer ||
      this.isTabBusy(activeTab.id) ||
      this.activeSessionState().switchingModel ||
      this.hasPendingPermission(activeTab.id)
    ) {
      return;
    }
    const tabId = activeTab.id;
    this.captureActiveConversationRuntime();
    this.updateControls(false);
    try {
      const result = await this.controller.restartConversation(tabId);
      this.conversationWorkspace = result.workspace;
      this.resetConversationView(tabId);
      this.editScopes.set(tabId, undefined);
      this.appendSystemMessage("New Hermes session started.", false, tabId);
      if (this.conversationWorkspace.activeTabId === tabId) {
        this.showConversationMessages(tabId);
        this.restoreActiveConversationRuntime();
      }
      this.renderConversationTabs();
    } catch (error) {
      if (
        error instanceof ConversationControllerError &&
        (error.code === "cancelled" || error.code === "operation_stale")
      ) {
        return;
      }
      new Notice(`Hermesian: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private appendUserMessage(
    text: string,
    selection?: SelectionContext,
    documentContext?: MarkdownDocumentContext,
    tabId = this.conversationWorkspace?.activeTabId,
    images: readonly PastedImageAttachment[] = [],
  ): void {
    const parent = tabId ? this.messageContainer(tabId) : this.messagesEl;
    const message = parent.createDiv({
      cls: "hermesian-message is-user",
    });
    if (selection) {
      message.createDiv({
        text: `${selection.filePath} · L${selection.startLine}–${selection.endLine}`,
        cls: "hermesian-message-context",
      });
    } else if (documentContext) {
      message.createDiv({
        text: `${documentContext.filePath} · full note context`,
        cls: "hermesian-message-context",
      });
    }
    message.createDiv({ text, cls: "hermesian-message-content" });
    if (images.length > 0) {
      const gallery = message.createDiv({ cls: "hermesian-message-images" });
      for (const image of images) {
        gallery.createEl("img", {
          attr: {
            alt: "Pasted image",
            src: `data:${image.mimeType};base64,${image.data}`,
          },
        });
      }
    }
    this.scrollToBottom(tabId);
  }

  private appendAssistantDelta(tabId: string, text: string): void {
    this.turnManager.appendDelta(tabId, text);
    this.scrollToBottom(tabId);
  }

  private appendThoughtDelta(tabId: string, text: string): void {
    this.turnManager.appendThought(tabId, text);
    this.scrollToBottom(tabId);
  }

  private async finalizeAssistantMessage(tabId: string): Promise<void> {
    const runtime = this.turnRuntime(tabId);
    const target = runtime.assistantContentEl;
    const text = runtime.assistantText;
    runtime.assistantContentEl = undefined;
    runtime.assistantText = "";
    runtime.thoughtContentEl = undefined;
    if (!target || !text) {
      return;
    }
    await this.renderMarkdown(target, text, this.editScopes.get(tabId)?.filePath);
    this.scrollToBottom(tabId);
  }

  private async renderMarkdown(
    target: HTMLElement,
    text: string,
    sourceFilePath?: string,
  ): Promise<void> {
    target.empty();
    target.removeClass("is-streaming");
    const sourcePath = sourceFilePath ?? this.currentFilePath ?? "";
    target.dataset.sourcePath = sourcePath;
    await MarkdownRenderer.render(
      this.app,
      normalizeMathDelimiters(text),
      target,
      sourcePath,
      this,
    );
    linkifyExternalUrls(target);
  }

  private openRenderedLink(event: MouseEvent): void {
    const eventTarget = event.target;
    const anchor = eventTarget instanceof Element
      ? eventTarget.closest<HTMLAnchorElement>("a")
      : null;
    if (!anchor) {
      return;
    }

    if (!anchor.hasClass("internal-link")) {
      const href = anchor.getAttribute("href");
      if (!href) {
        return;
      }
      try {
        const url = new URL(href);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      } catch {
        return;
      }
      return;
    }

    const linkText = anchor?.dataset.href ?? anchor?.getAttribute("href");
    if (!linkText) {
      return;
    }
    const sourcePath =
      anchor.closest<HTMLElement>(".hermesian-message-content")?.dataset.sourcePath ??
      this.currentFilePath ??
      "";
    event.preventDefault();
    event.stopPropagation();
    void this.app.workspace.openLinkText(
      linkText,
      sourcePath,
      event.metaKey || event.ctrlKey,
    );
  }

  private messageContainer(tabId: string): HTMLElement {
    return this.messageRenderer.containerFor(tabId);
  }

  private ensureTurnActivity(tabId: string): HTMLElement {
    return this.turnManager.ensureActivity(tabId);
  }

  private async finishTurn(tabId: string, reason: string): Promise<void> {
    return this.turnManager.complete(tabId, async () => {
      await this.finalizeAssistantMessage(tabId);
      this.appendStopReason(tabId, reason);
    });
  }

  private async finishFailedTurn(tabId: string): Promise<void> {
    return this.turnManager.complete(tabId, () =>
      this.finalizeAssistantMessage(tabId),
    );
  }

  private resetStreamingMessage(tabId: string): void {
    this.turnManager.resetStreaming(tabId);
  }

  private resetConversationView(tabId: string): void {
    this.turnManager.resetView(tabId);
    this.updateComposerPlaceholder();
  }

  private renderToolEvent(
    tabId: string,
    event: Extract<HermesUiEvent, { type: "tool" }>,
  ): void {
    const runtime = this.turnRuntime(tabId);
    let element = runtime.toolEls.get(event.id);
    if (!element) {
      element = this.ensureTurnActivity(tabId).createDiv({ cls: "hermesian-tool" });
      runtime.toolEls.set(event.id, element);
    }
    element.empty();
    const icon = element.createSpan();
    setIcon(icon, event.kind === "edit" ? "file-pen-line" : "wrench");
    element.createSpan({ text: event.title, cls: "hermesian-tool-title" });
    element.createSpan({
      text: event.status ?? "pending",
      cls: "hermesian-tool-status",
    });
    this.scrollToBottom(tabId);
  }

  private renderPermissionContents(
    card: HTMLElement,
    contents: ToolCallContent[],
  ): void {
    const diffs = contents.filter(
      (content): content is Extract<ToolCallContent, { type: "diff" }> =>
        content.type === "diff",
    );
    for (const diff of diffs) {
      card.createDiv({ text: diff.path, cls: "hermesian-diff-path" });
      const diffEl = card.createEl("pre", { cls: "hermesian-diff" });
      for (const part of diffLines(diff.oldText ?? "", diff.newText)) {
        const span = diffEl.createSpan({
          cls: part.added
            ? "hermesian-diff-added"
            : part.removed
              ? "hermesian-diff-removed"
              : "hermesian-diff-context",
        });
        const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
        span.setText(
          part.value
            .split("\n")
            .filter((line, index, lines) => index < lines.length - 1 || line)
            .map((line) => `${prefix}${line}\n`)
            .join(""),
        );
      }
    }

    if (diffs.length === 0 && requestHasRawContent(contents)) {
      card.createEl("pre", {
        text: contents
          .map((content) => JSON.stringify(content, null, 2))
          .join("\n"),
        cls: "hermesian-permission-raw",
      });
    }
  }

  private addPermissionButton(
    actions: HTMLElement,
    option: PermissionOption,
    finish: (response: RequestPermissionResponse) => void,
  ): void {
    const button = actions.createEl("button", {
      text: option.name,
      cls: option.kind.startsWith("allow") ? "mod-cta" : "mod-warning",
    });
    button.addEventListener("click", () => {
      finish({
        outcome: {
          outcome: "selected",
          optionId: option.optionId,
        },
      });
    });
  }

  private appendSystemMessage(
    text: string,
    error = false,
    tabId = this.conversationWorkspace?.activeTabId,
  ): void {
    const runtime = tabId ? this.turnManager.ensure(tabId) : undefined;
    const parent = tabId
      ? runtime?.activeTurnEl
        ? this.ensureTurnActivity(tabId)
        : this.messageContainer(tabId)
      : this.messagesEl;
    const message = parent.createDiv({
      attr: {
        "aria-live": error ? "assertive" : "polite",
        role: error ? "alert" : "status",
      },
      cls: `hermesian-system${error ? " is-error" : ""}`,
    });
    message.setText(text);
    this.scrollToBottom(tabId);
  }

  private appendStopReason(tabId: string, reason: string): void {
    if (reason !== "end_turn") {
      this.appendSystemMessage(`Turn stopped: ${reason}`, false, tabId);
    }
  }

  private updateControls(_busy: boolean, _showStop = _busy): void {
    const availability = this.controlAvailability();
    if (!availability.composer) {
      this.hideSlashMenu();
    }
    applyComposerState(
      {
        composerEl: this.composerEl,
        sendButtonEl: this.sendButtonEl,
        stopButtonEl: this.stopButtonEl,
      },
      {
        disabled: !availability.composer,
        draft: this.getComposerCanonicalDraft(),
        placeholder: this.composerPlaceholder(),
        sendEnabled: availability.send,
        stopVisible: availability.stop,
      },
    );
    this.renderAddConversationControl();
    this.historyButtonEl.disabled = !availability.history;
    this.reasoningButtonEl.disabled = !availability.reasoning;
    this.renderConversationTabs();
    this.renderSessionState(this.activeSessionState());
  }

  private getComposerCanonicalDraft(): string {
    return serializeComposerSlashDraft({
      token: this.composerSlashToken,
      task: this.composerEl.value,
    });
  }

  /**
   * Value used for slash-menu matching.
   * With an active token the textarea only holds the task, so rebuild the
   * canonical prefix for menu queries (empty task → "/skill name " form).
   */
  private getComposerSlashMenuValue(): string {
    if (!this.composerSlashToken) {
      return this.composerEl.value;
    }
    return serializeComposerSlashDraft({
      token: this.composerSlashToken,
      task: this.composerEl.value,
    });
  }

  private applyComposerCanonicalDraft(
    raw: string,
    explicitToken?: { kind: "skill" | "command"; name: string } | null,
  ): void {
    // Single restore decision: restoreComposerSlashDraft validates both the
    // token metadata AND the draft prefix consistency. Never show a token
    // before checking; on any mismatch the raw draft stays verbatim.
    const restored = restoreComposerSlashDraft(raw, explicitToken);
    this.setComposerSlashToken(restored.token);
    this.composerEl.value = restored.task;
  }

  private setComposerSlashToken(token: ComposerSlashToken | null): void {
    this.composerSlashToken = token;
    applyComposerSlashToken(
      {
        slashTokenEl: this.slashTokenEl,
        slashTokenIconEl: this.slashTokenIconEl,
        slashTokenLabelEl: this.slashTokenLabelEl,
        composerEl: this.composerEl,
      },
      token,
    );
    if (token) {
      const iconName = token.kind === "skill" ? "sparkles" : "terminal";
      setIcon(this.slashTokenIconEl, iconName);
    } else {
      this.slashTokenIconEl.empty();
    }
    this.updateComposerPlaceholder();
  }

  private composerPlaceholder(): string {
    const activeTabId = this.conversationWorkspace?.activeTabId;
    if (this.composerSlashToken) {
      return activeTabId && this.isTabLoading(activeTabId)
        ? "Add a task for this command…"
        : "Add a task…  ↵ to send · Shift+↵ for new line";
    }
    return activeTabId && this.isTabLoading(activeTabId)
      ? "Draft here — this conversation is starting"
      : "Ask Hermes…  ↵ to send · Shift+↵ for new line";
  }

  private updateComposerPlaceholder(): void {
    this.composerEl.placeholder = this.composerPlaceholder();
  }

  private scrollToBottom(sourceTabId?: string): void {
    this.messageRenderer.scrollToBottom(sourceTabId);
  }

  private messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function requestHasRawContent(contents: ToolCallContent[]): boolean {
  return contents.length > 0;
}
