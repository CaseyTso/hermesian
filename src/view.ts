import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import { diffLines } from "diff";
import {
  type App,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  SuggestModal,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

import type HermesianPlugin from "./main";
import {
  activateConversationTab,
  addPendingConversationTab,
  conversationControlAvailability,
  conversationControlsBusy,
  createConversationWorkspace,
  removeConversationTab,
  replaceConversationSession,
  shouldAutoScrollConversation,
  updateConversationTab,
  type PersistedConversationTab,
  type PersistedConversationWorkspace,
} from "./conversation-tabs";
import { linkifyExternalUrls } from "./external-links";
import { HERMESIAN_ICON_ID } from "./hermes-icon";
import {
  contextUsageLevel,
  contextUsagePercent,
  formatContextUsage,
} from "./session-state";
import {
  buildDocumentPrompt,
  buildSelectionPrompt,
  validateSelectionEdit,
} from "./selection-context";
import { REASONING_EFFORTS, reasoningEffortLabel } from "./session-history";
import {
  buildSlashOutboundPrompt,
  buildSlashMenuItems,
  slashMenuInsertion,
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

export const HERMESIAN_VIEW_TYPE = "hermesian-sidebar";

const OBSIDIAN_OUTPUT_RULES = `<hermesian_output_rules>
When referring to a note in the current Obsidian Vault, use an Obsidian wikilink such as [[folder/note|note]]. Preserve heading (#) and block (^) suffixes when relevant. Do not wrap wikilinks in backticks or code blocks.
</hermesian_output_rules>`;

interface PendingPermission {
  card: HTMLElement;
  resolve: (response: RequestPermissionResponse) => void;
  tabId: string;
}

interface ConversationTurnRuntime {
  activeEditScope?: SelectionContext | MarkdownDocumentContext;
  activeTurnEl?: HTMLElement;
  assistantContentEl?: HTMLElement;
  assistantText: string;
  busy: boolean;
  completionPromise?: Promise<void>;
  thoughtContentEl?: HTMLElement;
  toolEls: Map<string, HTMLElement>;
  turnActivityEl?: HTMLElement;
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

class HermesModelSuggestModal extends SuggestModal<HermesModelOption> {
  constructor(
    app: App,
    private readonly models: HermesModelOption[],
    private readonly currentSwitchId: string | undefined,
    private readonly choose: (model: HermesModelOption) => void,
  ) {
    super(app);
    this.setPlaceholder("Search provider or model…");
  }

  getSuggestions(query: string): HermesModelOption[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.models;
    }
    return this.models.filter((model) =>
      [model.providerName, model.providerId, model.name, model.modelId, model.description]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }

  renderSuggestion(model: HermesModelOption, element: HTMLElement): void {
    const row = element.createDiv({ cls: "hermesian-model-suggestion" });
    const copy = row.createDiv({ cls: "hermesian-model-suggestion-copy" });
    copy.createDiv({ text: model.name, cls: "hermesian-model-suggestion-name" });
    copy.createDiv({
      text: `${model.providerName}${model.description ? ` · ${model.description}` : ""}`,
      cls: "hermesian-model-suggestion-provider",
    });
    if (model.switchId === this.currentSwitchId) {
      const check = row.createSpan({ cls: "hermesian-model-suggestion-check" });
      setIcon(check, "check");
    }
  }

  onChooseSuggestion(model: HermesModelOption): void {
    this.choose(model);
  }
}

class HermesHistorySuggestModal extends SuggestModal<HermesHistoryEntry> {
  constructor(
    app: App,
    private readonly sessions: HermesHistoryEntry[],
    private readonly choose: (session: HermesHistoryEntry) => void,
  ) {
    super(app);
    this.setPlaceholder("Search historical Hermes sessions…");
  }

  getSuggestions(query: string): HermesHistoryEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.sessions;
    }
    return this.sessions.filter((session) =>
      [session.title ?? "", session.sessionId, session.cwd]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }

  renderSuggestion(session: HermesHistoryEntry, element: HTMLElement): void {
    const row = element.createDiv({ cls: "hermesian-history-suggestion" });
    row.createDiv({
      text: session.title || "Untitled Hermes session",
      cls: "hermesian-history-title",
    });
    row.createDiv({
      text: `${session.updatedAt ?? "No timestamp"} · ${session.sessionId}`,
      cls: "hermesian-history-meta",
    });
  }

  onChooseSuggestion(session: HermesHistoryEntry): void {
    this.choose(session);
  }
}

class HermesReasoningSuggestModal extends SuggestModal<ReasoningEffort> {
  constructor(
    app: App,
    private readonly current: ReasoningEffort,
    private readonly choose: (effort: ReasoningEffort) => void,
  ) {
    super(app);
    this.setPlaceholder("Select thinking depth…");
  }

  getSuggestions(query: string): ReasoningEffort[] {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? REASONING_EFFORTS.filter((effort) =>
          reasoningEffortLabel(effort).toLowerCase().includes(normalized),
        )
      : REASONING_EFFORTS;
  }

  renderSuggestion(effort: ReasoningEffort, element: HTMLElement): void {
    const row = element.createDiv({ cls: "hermesian-reasoning-option" });
    row.createSpan({ text: reasoningEffortLabel(effort) });
    if (effort === this.current) {
      const check = row.createSpan({ cls: "hermesian-reasoning-check" });
      setIcon(check, "check");
    }
  }

  onChooseSuggestion(effort: ReasoningEffort): void {
    this.choose(effort);
  }
}

export class HermesianSidebarView extends ItemView {
  private addConversationButtonEl!: HTMLButtonElement;
  private composerEl!: HTMLTextAreaElement;
  private conversationTabsEl!: HTMLElement;
  private conversationWorkspace: PersistedConversationWorkspace | undefined;
  private contextProgressEl!: HTMLElement;
  private contextUsageEl!: HTMLElement;
  private controlsBusy = false;
  private currentFileBarEl!: HTMLButtonElement;
  private currentFileLabelEl!: HTMLElement;
  private currentFilePath: string | undefined;
  private includeCurrentDocumentContext = true;
  private initializing = true;
  private historyButtonEl!: HTMLButtonElement;
  private messagesEl!: HTMLElement;
  private modelButtonEl!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private pendingSelection: SelectionContext | undefined;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly clientLoadingTabs = new Set<string>();
  private readonly loadedMessageTabIds = new Set<string>();
  private readonly messageCaches = new Map<string, HTMLElement>();
  private readonly sessionStates = new Map<string, HermesSessionState>();
  private readonly turnRuntimes = new Map<string, ConversationTurnRuntime>();
  private reasoningButtonEl!: HTMLButtonElement;
  private reasoningLabelEl!: HTMLElement;
  private selectionBarEl!: HTMLElement;
  private sendButtonEl!: HTMLButtonElement;
  private sessionState: HermesSessionState = {
    catalogLoading: false,
    commands: [],
    models: [],
    skillCatalogLoading: false,
    skills: [],
    switchingModel: false,
  };
  private slashMenuEl!: HTMLElement;
  private slashMenuIndex = 0;
  private slashMenuItems: SlashMenuItem[] = [];
  private statusEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private readonly tabSelections = new Map<string, SelectionContext | undefined>();
  private tabSwitchGeneration = 0;
  private visibleMessagesTabId: string | undefined;

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
    this.initializing = true;
    this.renderShell();
    this.updateControls(true, false);
    this.plugin.attachView(this);
    try {
      const persisted = this.plugin.getConversationWorkspace();
      const activeTabId = persisted?.activeTabId ?? crypto.randomUUID();
      const client = this.plugin.getClient(activeTabId);
      await client.connect();
      await this.initializeConversationWorkspace(activeTabId, client, persisted);
    } catch (error) {
      new Notice(`Hermesian connection failed: ${this.messageFor(error)}`);
    } finally {
      this.initializing = false;
      this.updateControls(false);
    }
  }

  async onClose(): Promise<void> {
    this.captureActiveConversationRuntime();
    await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    for (const permission of this.permissions.values()) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
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
          this.turnRuntime(tabId).activeEditScope = undefined;
          void this.finishFailedTurn(tabId);
        }
        return;
      case "turn-stop":
        this.turnRuntime(tabId).activeEditScope = undefined;
        void this.finishTurn(tabId, event.reason);
        return;
    }
  }

  handleHermesSessionState(tabId: string, state: HermesSessionState): void {
    this.sessionStates.set(tabId, state);
    if (!this.conversationWorkspace || this.conversationWorkspace.activeTabId === tabId) {
      this.renderSessionState(state);
    }
  }

  requestPermission(
    tabId: string,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    this.revealActiveTurnForPermission(tabId);
    const runtime = this.turnRuntime(tabId);
    const permissionId = `${tabId}:${request.toolCall.toolCallId}`;
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
      const validation = validateSelectionEdit(runtime.activeEditScope, diffs);
      if (validation.allowed === false) {
        this.appendSystemMessage(`Blocked edit: ${validation.reason}`, true, tabId);
        return Promise.resolve(rejectionFor(request.options));
      }
    }
    try {
      const automatic = this.plugin.automaticPermissionResponse(request);
      if (automatic) {
        return Promise.resolve(automatic);
      }
    } catch (error) {
      this.appendSystemMessage(
        `Blocked edit outside vault: ${this.messageFor(error)}`,
        true,
        tabId,
      );
      return Promise.resolve(rejectionFor(request.options));
    }
    if (signal.aborted) {
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
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("hermesian-view");

    const header = root.createDiv({ cls: "hermesian-header" });
    const identity = header.createDiv({ cls: "hermesian-identity" });
    const logo = identity.createSpan({ cls: "hermesian-logo" });
    setIcon(logo, HERMESIAN_ICON_ID);
    identity.createSpan({ text: "Hermesian", cls: "hermesian-title" });
    this.statusEl = identity.createSpan({
      text: "Disconnected",
      cls: "hermesian-status",
    });

    const headerActions = header.createDiv({ cls: "hermesian-header-actions" });
    this.addConversationButtonEl = headerActions.createEl("button", {
      attr: {
        "aria-label": "Add conversation",
        title: "Add conversation",
        type: "button",
      },
      cls: "clickable-icon",
    });
    setIcon(this.addConversationButtonEl, "square-plus");
    this.addConversationButtonEl.addEventListener("click", () => {
      void this.addConversation();
    });
    this.historyButtonEl = headerActions.createEl("button", {
      attr: {
        "aria-label": "View Hermes history",
        title: "Browse and resume historical sessions",
      },
      cls: "clickable-icon",
    });
    setIcon(this.historyButtonEl, "history");
    this.historyButtonEl.addEventListener("click", () => {
      void this.openHistoryPicker();
    });

    this.conversationTabsEl = root.createDiv({
      attr: { "aria-label": "Hermes conversations", role: "tablist" },
      cls: "hermesian-conversation-tabs",
    });

    this.messagesEl = root.createDiv({ cls: "hermesian-messages" });
    this.messagesEl.addEventListener("click", (event) => {
      this.openRenderedLink(event);
    });
    this.appendSystemMessage(
      "Select text in a Markdown note, run “Ask Hermes about selection”, then describe the change you want.",
    );

    const composer = root.createDiv({ cls: "hermesian-composer" });
    const composerContexts = composer.createDiv({ cls: "hermesian-composer-contexts" });
    this.currentFileBarEl = composerContexts.createEl("button", {
      attr: { type: "button" },
      cls: "hermesian-current-file",
    }) as HTMLButtonElement;
    const currentFileIcon = this.currentFileBarEl.createSpan({
      cls: "hermesian-current-file-icon",
    });
    setIcon(currentFileIcon, "file-text");
    this.currentFileLabelEl = this.currentFileBarEl.createSpan({
      cls: "hermesian-current-file-label",
    });
    this.currentFileBarEl.addEventListener("click", () => {
      if (!this.currentFilePath) {
        return;
      }
      this.includeCurrentDocumentContext = !this.includeCurrentDocumentContext;
      this.renderCurrentFile();
      this.captureActiveConversationRuntime();
    });
    this.renderCurrentFile();

    this.selectionBarEl = composerContexts.createDiv({ cls: "hermesian-selection-bar" });
    this.selectionBarEl.hide();

    this.composerEl = composer.createEl("textarea", {
      attr: {
        "aria-autocomplete": "list",
        "aria-controls": "hermesian-slash-menu",
        "aria-expanded": "false",
        "aria-label": "Message Hermes",
        placeholder: "Ask Hermes…  ↵ to send · Shift+↵ for new line",
        role: "combobox",
        rows: "3",
      },
      cls: "hermesian-input",
    });
    this.composerEl.addEventListener("keydown", (event) => {
      if (this.handleSlashMenuKeydown(event)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.composerEl.addEventListener("input", () => {
      this.renderSlashMenu(true);
      this.captureActiveConversationRuntime();
    });
    this.composerEl.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!this.slashMenuEl.contains(this.containerEl.ownerDocument.activeElement)) {
          this.hideSlashMenu();
        }
      }, 0);
    });

    this.slashMenuEl = composer.createDiv({
      attr: {
        "aria-label": "Hermes slash commands and skills",
        id: "hermesian-slash-menu",
        role: "listbox",
      },
      cls: "hermesian-slash-menu",
    });
    this.slashMenuEl.hide();

    const composerFooter = composer.createDiv({ cls: "hermesian-composer-footer" });
    const controlRow = composerFooter.createDiv({ cls: "hermesian-control-row" });
    this.modelButtonEl = controlRow.createEl("button", {
      attr: { "aria-label": "Select Hermes model" },
      cls: "hermesian-model-button",
    });
    const modelIcon = this.modelButtonEl.createSpan({ cls: "hermesian-model-icon" });
    setIcon(modelIcon, "bot");
    this.modelLabelEl = this.modelButtonEl.createSpan({
      text: "Loading model…",
      cls: "hermesian-model-label",
    });
    const chevron = this.modelButtonEl.createSpan({ cls: "hermesian-model-chevron" });
    setIcon(chevron, "chevron-down");
    this.modelButtonEl.addEventListener("click", () => this.openModelPicker());

    this.reasoningButtonEl = controlRow.createEl("button", {
      attr: { "aria-label": "Adjust Hermes thinking depth" },
      cls: "hermesian-reasoning-button",
    });
    const reasoningIcon = this.reasoningButtonEl.createSpan({ cls: "hermesian-reasoning-icon" });
    setIcon(reasoningIcon, "brain");
    this.reasoningLabelEl = this.reasoningButtonEl.createSpan({ cls: "hermesian-reasoning-label" });
    this.renderReasoningButton();
    this.reasoningButtonEl.addEventListener("click", () => {
      void this.openReasoningPicker();
    });

    const addSelectionButton = controlRow.createEl("button", {
      attr: {
        "aria-label": "Add selection",
        title: "Add selection",
        type: "button",
      },
      cls: "clickable-icon hermesian-add-selection",
    });
    setIcon(addSelectionButton, "paperclip");
    let selectionSource: MarkdownView | undefined;
    let renderedSelection = "";
    addSelectionButton.addEventListener("pointerdown", (event) => {
      selectionSource =
        this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
      renderedSelection =
        this.containerEl.ownerDocument.getSelection()?.toString() ?? "";
      event.preventDefault();
    });
    addSelectionButton.addEventListener("click", () => {
      const source = selectionSource;
      const selectedText = renderedSelection;
      selectionSource = undefined;
      renderedSelection = "";
      void this.plugin.captureAndAttachSelection(source, selectedText);
    });

    this.sendButtonEl = controlRow.createEl("button", {
      attr: {
        "aria-label": "Send message",
        title: "Send message",
        type: "button",
      },
      cls: "clickable-icon hermesian-primary-action is-send",
    });
    const sendIcon = this.sendButtonEl.createSpan();
    setIcon(sendIcon, "arrow-right");
    this.sendButtonEl.addEventListener("click", () => {
      void this.sendMessage();
    });

    this.stopButtonEl = controlRow.createEl("button", {
      attr: {
        "aria-label": "Stop response",
        title: "Stop response",
        type: "button",
      },
      cls: "clickable-icon hermesian-primary-action is-stop",
    });
    const stopIcon = this.stopButtonEl.createSpan();
    setIcon(stopIcon, "square");
    this.stopButtonEl.hide();
    this.stopButtonEl.addEventListener("click", () => {
      const activeTab = this.activeConversationTab();
      if (activeTab) {
        void this.plugin.getClient(activeTab.id).cancel();
      }
    });

    const context = composerFooter.createDiv({ cls: "hermesian-context" });
    this.contextUsageEl = context.createDiv({
      text: "Context —",
      cls: "hermesian-context-label",
    });
    const contextTrack = context.createDiv({ cls: "hermesian-context-track" });
    this.contextProgressEl = contextTrack.createDiv({
      cls: "hermesian-context-progress",
    });
  }

  private async initializeConversationWorkspace(
    initialTabId: string,
    client: HermesAcpClient,
    persisted: PersistedConversationWorkspace | undefined,
  ): Promise<void> {
    if (!persisted) {
      const sessionId = client.sessionId;
      if (!sessionId) {
        throw new Error("Hermes ACP did not create an initial session");
      }
      this.conversationWorkspace = createConversationWorkspace(
        initialTabId,
        sessionId,
      );
      this.showConversationMessages(initialTabId);
      this.loadedMessageTabIds.add(initialTabId);
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
      return;
    }

    this.conversationWorkspace = persisted;
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      throw new Error("The saved conversation workspace has no active tab");
    }
    this.showConversationMessages(activeTab.id);
    this.renderConversationTabs();

    this.updateControls(true, false);
    try {
      let restoredItems: HermesHistoryItem[] | undefined;
      let restoredSessionId = activeTab.sessionId;
      if (restoredSessionId) {
        try {
          restoredItems = await client.loadSessionHistory(restoredSessionId);
        } catch (error) {
          await client.newSession();
          const replacementSessionId = client.sessionId;
          if (!replacementSessionId) {
            throw error;
          }
          this.conversationWorkspace = replaceConversationSession(
            this.conversationWorkspace,
            activeTab.id,
            replacementSessionId,
          );
          restoredSessionId = replacementSessionId;
          this.resetConversationView(activeTab.id);
          this.appendSystemMessage(
            "The saved Hermes session could not be restored. A new session was started for this tab.",
            true,
          );
        }
      } else {
        restoredSessionId = await this.bindPendingConversation(activeTab.id, true);
        this.resetConversationView(activeTab.id);
        this.loadedMessageTabIds.add(activeTab.id);
        this.appendSystemMessage("New Hermes conversation started.");
      }
      if (restoredItems && restoredSessionId) {
        await this.renderHistorySession(
          { cwd: "", sessionId: restoredSessionId },
          restoredItems,
          false,
        );
      }
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    } finally {
      this.updateControls(false);
    }
  }

  private activeConversationTab(): PersistedConversationTab | undefined {
    return this.conversationWorkspace?.tabs.find(
      (tab) => tab.id === this.conversationWorkspace?.activeTabId,
    );
  }

  private turnRuntime(tabId: string): ConversationTurnRuntime {
    let runtime = this.turnRuntimes.get(tabId);
    if (!runtime) {
      runtime = {
        assistantText: "",
        busy: false,
        toolEls: new Map<string, HTMLElement>(),
      };
      this.turnRuntimes.set(tabId, runtime);
    }
    return runtime;
  }

  private isTabBusy(tabId: string): boolean {
    return (
      this.turnRuntimes.get(tabId)?.busy === true ||
      this.plugin.peekClient(tabId)?.isBusy === true
    );
  }

  private hasPendingPermission(tabId: string): boolean {
    return Array.from(this.permissions.values()).some(
      (permission) => permission.tabId === tabId,
    );
  }


  private activeSessionState(): HermesSessionState {
    const activeTab = this.activeConversationTab();
    return (activeTab && this.sessionStates.get(activeTab.id)) ?? this.sessionState;
  }

  private controlAvailability(state = this.activeSessionState()) {
    const activeTab = this.activeConversationTab();
    const activeTabId = activeTab?.id;
    return conversationControlAvailability({
      activeTabBusy: Boolean(activeTabId && this.isTabBusy(activeTabId)),
      activeTabLoading: Boolean(activeTabId && this.clientLoadingTabs.has(activeTabId)),
      activeTabPermissionPending: Boolean(
        activeTabId && this.hasPendingPermission(activeTabId),
      ),
      anyTabBusy: this.plugin.hasBusyClient(),
      anyTabLoading: this.clientLoadingTabs.size > 0,
      anyPermissionPending: this.permissions.size > 0,
      controlsBusy: this.controlsBusy,
      hasSession: Boolean(activeTab?.sessionId),
      initializing: this.initializing,
      switchingModel: state.switchingModel,
    });
  }

  private async ensureClientForTab(
    tabId: string,
  ): Promise<{ items?: HermesHistoryItem[]; sessionId: string; started: boolean }> {
    const workspace = this.conversationWorkspace;
    const tab = workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!workspace || !tab) {
      throw new Error("The conversation tab could not be found");
    }
    const client = this.plugin.getClient(tabId);
    this.clientLoadingTabs.add(tabId);
    if (workspace.activeTabId === tabId) {
      this.updateControls(false);
    }
    try {
      await client.connect();
      if (
        tab.sessionId &&
        (client.sessionId !== tab.sessionId || !this.loadedMessageTabIds.has(tabId))
      ) {
        const items = await client.loadSessionHistory(tab.sessionId);
        return { items, sessionId: tab.sessionId, started: false };
      }
      const sessionId = tab.sessionId ?? client.sessionId;
      if (!sessionId) {
        throw new Error("Hermes ACP did not return a session ID");
      }
      if (!tab.sessionId) {
        this.conversationWorkspace = replaceConversationSession(
          this.conversationWorkspace ?? workspace,
          tabId,
          sessionId,
        );
      }
      return { sessionId, started: !tab.sessionId };
    } finally {
      this.clientLoadingTabs.delete(tabId);
      if (this.conversationWorkspace?.activeTabId === tabId) {
        this.updateControls(false);
      }
    }
  }

  private async bindPendingConversation(
    tabId: string,
    useCurrentSession = false,
  ): Promise<string> {
    const workspace = this.conversationWorkspace;
    const tab = workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!workspace || !tab) {
      throw new Error("The deferred conversation tab could not be found");
    }
    if (tab.sessionId) {
      return tab.sessionId;
    }

    const client = this.plugin.getClient(tabId);
    let sessionId = useCurrentSession ? client.sessionId : undefined;
    if (!sessionId) {
      await client.connect();
      sessionId = client.sessionId;
    }
    if (!sessionId) {
      throw new Error("Hermes ACP did not return a new session ID");
    }

    this.conversationWorkspace = replaceConversationSession(
      this.conversationWorkspace ?? workspace,
      tabId,
      sessionId,
    );
    return sessionId;
  }

  private ensureMessageCache(tabId: string): HTMLElement {
    let cache = this.messageCaches.get(tabId);
    if (!cache) {
      cache = this.containerEl.ownerDocument.createElement("div");
      this.messageCaches.set(tabId, cache);
    }
    return cache;
  }

  private showConversationMessages(tabId: string): void {
    if (!this.visibleMessagesTabId) {
      this.visibleMessagesTabId = tabId;
      return;
    }
    if (this.visibleMessagesTabId === tabId) {
      return;
    }

    const visibleCache = this.ensureMessageCache(this.visibleMessagesTabId);
    visibleCache.replaceChildren(...Array.from(this.messagesEl.childNodes));
    const targetCache = this.ensureMessageCache(tabId);
    this.messagesEl.replaceChildren(...Array.from(targetCache.childNodes));
    this.visibleMessagesTabId = tabId;
    this.scrollToBottom();
  }

  private forgetConversationMessages(tabId: string): void {
    this.loadedMessageTabIds.delete(tabId);
    this.messageCaches.delete(tabId);
  }

  private revealActiveTurnForPermission(tabId: string): void {
    const workspace = this.conversationWorkspace;
    if (!workspace || workspace.activeTabId === tabId) {
      return;
    }
    this.captureActiveConversationRuntime();
    this.conversationWorkspace = activateConversationTab(workspace, tabId);
    this.showConversationMessages(tabId);
    this.restoreActiveConversationRuntime();
    this.renderSessionState(
      this.sessionStates.get(tabId) ?? this.plugin.getClient(tabId).currentSessionState,
    );
    this.renderConversationTabs();
    this.updateControls(false);
    void this.plugin.flushConversationWorkspace(this.conversationWorkspace).catch((error) => {
      new Notice(`Hermesian could not save the active conversation: ${this.messageFor(error)}`);
    });
  }

  private captureActiveConversationRuntime(): void {
    const workspace = this.conversationWorkspace;
    if (!workspace) {
      return;
    }
    const activeTabId = workspace.activeTabId;
    this.tabSelections.set(activeTabId, this.pendingSelection);
    this.conversationWorkspace = updateConversationTab(workspace, activeTabId, {
      draft: this.composerEl.value,
      includeCurrentDocumentContext: this.includeCurrentDocumentContext,
    });
    this.plugin.setConversationWorkspace(this.conversationWorkspace);
  }

  private restoreActiveConversationRuntime(): void {
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    this.composerEl.value = activeTab.draft;
    this.includeCurrentDocumentContext = activeTab.includeCurrentDocumentContext;
    this.pendingSelection = this.tabSelections.get(activeTab.id);
    this.renderCurrentFile();
    this.renderSelectionBar();
    this.hideSlashMenu();
  }

  private renderConversationTabs(): void {
    if (!this.conversationTabsEl) {
      return;
    }
    this.conversationTabsEl.empty();
    const workspace = this.conversationWorkspace;
    if (!workspace) {
      return;
    }
    for (const tab of workspace.tabs) {
      const active = tab.id === workspace.activeTabId;
      const deferred = tab.sessionId === null;
      const working = this.isTabBusy(tab.id);
      const button = this.conversationTabsEl.createEl("button", {
        attr: {
          "aria-label": `Conversation ${tab.label}${working ? ", responding" : deferred ? ", waiting to start" : ""}`,
          "aria-selected": String(active),
          role: "tab",
          title: `Conversation ${tab.label}${working ? " · Responding" : deferred ? " · Starting" : ""} · Right-click to close`,
          type: "button",
        },
        cls: `hermesian-conversation-tab${active ? " is-active" : ""}${working ? " is-working" : ""}${deferred ? " is-deferred" : ""}`,
        text: String(tab.label),
      });
      button.disabled = this.initializing;
      button.addEventListener("click", () => {
        void this.switchConversation(tab.id);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.closeConversation(tab.id);
      });
    }
    this.conversationTabsEl
      .querySelector<HTMLElement>(".hermesian-conversation-tab.is-active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private async addConversation(): Promise<void> {
    if (this.initializing || this.activeSessionState().switchingModel) {
      return;
    }
    this.captureActiveConversationRuntime();
    const workspace = this.conversationWorkspace;
    if (!workspace) {
      return;
    }
    const tabId = crypto.randomUUID();
    this.conversationWorkspace = addPendingConversationTab(workspace, tabId);
    this.pendingSelection = undefined;
    this.tabSelections.set(tabId, undefined);
    this.showConversationMessages(tabId);
    this.resetConversationView(tabId);
    this.restoreActiveConversationRuntime();
    this.renderConversationTabs();
    this.appendSystemMessage("Starting a new Hermes conversation…", false, tabId);
    this.updateControls(false);
    try {
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
      const client = this.plugin.getClient(tabId);
      await client.connect();
      const sessionId = client.sessionId;
      if (!sessionId) {
        throw new Error("Hermes ACP did not return a new session ID");
      }
      this.conversationWorkspace = replaceConversationSession(
        this.conversationWorkspace,
        tabId,
        sessionId,
      );
      if (this.conversationWorkspace.activeTabId === tabId) {
        this.showConversationMessages(tabId);
        this.resetConversationView(tabId);
      }
      this.loadedMessageTabIds.add(tabId);
      this.renderConversationTabs();
      this.appendSystemMessage("New Hermes conversation started.", false, tabId);
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    } catch (error) {
      new Notice(`Hermesian could not add a conversation: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private async closeConversation(tabId: string): Promise<void> {
    const initialWorkspace = this.conversationWorkspace;
    if (
      !initialWorkspace ||
      !initialWorkspace.tabs.some((tab) => tab.id === tabId) ||
      this.initializing ||
      this.isTabBusy(tabId) ||
      this.clientLoadingTabs.has(tabId) ||
      this.hasPendingPermission(tabId) ||
      this.sessionStates.get(tabId)?.switchingModel
    ) {
      return;
    }

    this.captureActiveConversationRuntime();
    const workspace = this.conversationWorkspace ?? initialWorkspace;
    const closingActiveTab = workspace.activeTabId === tabId;
    try {
      if (workspace.tabs.length === 1) {
        const replacementTabId = crypto.randomUUID();
        const withReplacement = addPendingConversationTab(workspace, replacementTabId);
        const updated = removeConversationTab(withReplacement, tabId);
        if (!updated) {
          throw new Error("Hermesian could not create a replacement conversation tab");
        }
        this.conversationWorkspace = updated;
        this.tabSelections.delete(tabId);
        this.tabSelections.set(replacementTabId, undefined);
        this.showConversationMessages(replacementTabId);
        this.resetConversationView(replacementTabId);
        this.forgetConversationMessages(tabId);
        this.turnRuntimes.delete(tabId);
        this.sessionStates.delete(tabId);
        await this.plugin.releaseClient(tabId);
        const { sessionId } = await this.ensureClientForTab(replacementTabId);
        this.conversationWorkspace = replaceConversationSession(
          this.conversationWorkspace,
          replacementTabId,
          sessionId,
        );
        this.loadedMessageTabIds.add(replacementTabId);
        this.restoreActiveConversationRuntime();
        this.renderConversationTabs();
        this.appendSystemMessage(
          "Conversation closed. A new Hermes conversation started.",
          false,
          replacementTabId,
        );
        await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
        return;
      }

      const updated = removeConversationTab(workspace, tabId);
      if (!updated) {
        throw new Error("Hermesian could not close that conversation tab");
      }

      if (!closingActiveTab) {
        this.conversationWorkspace = updated;
        this.tabSelections.delete(tabId);
        this.forgetConversationMessages(tabId);
        this.turnRuntimes.delete(tabId);
        this.sessionStates.delete(tabId);
        await this.plugin.releaseClient(tabId);
        this.renderConversationTabs();
        await this.plugin.flushConversationWorkspace(updated);
        return;
      }

      const target = updated.tabs.find((tab) => tab.id === updated.activeTabId);
      if (!target) {
        throw new Error("The next conversation tab could not be found");
      }
      this.conversationWorkspace = updated;
      this.tabSelections.delete(tabId);
      this.showConversationMessages(target.id);
      this.forgetConversationMessages(tabId);
      this.turnRuntimes.delete(tabId);
      this.sessionStates.delete(tabId);
      await this.plugin.releaseClient(tabId);
      const { items, sessionId, started } = await this.ensureClientForTab(target.id);
      if (items) {
        await this.renderHistorySession({ cwd: "", sessionId }, items, false);
      } else if (started) {
        this.resetConversationView(target.id);
        this.loadedMessageTabIds.add(target.id);
        this.appendSystemMessage("New Hermes conversation started.", false, target.id);
      }
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    } catch (error) {
      new Notice(`Hermesian could not close that conversation: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private async switchConversation(tabId: string): Promise<void> {
    const workspace = this.conversationWorkspace;
    if (!workspace || workspace.activeTabId === tabId || this.initializing) {
      return;
    }
    const target = workspace.tabs.find((tab) => tab.id === tabId);
    if (!target) {
      return;
    }

    this.captureActiveConversationRuntime();
    const generation = ++this.tabSwitchGeneration;
    this.conversationWorkspace = activateConversationTab(
      this.conversationWorkspace ?? workspace,
      target.id,
    );
    this.showConversationMessages(target.id);
    if (!this.loadedMessageTabIds.has(target.id) && this.messagesEl.childElementCount === 0) {
      this.messagesEl.createDiv({
        cls: "hermesian-system is-background-waiting",
        text: "Loading this conversation…",
      });
    }
    this.restoreActiveConversationRuntime();
    this.renderSessionState(
      this.sessionStates.get(target.id) ?? this.plugin.getClient(target.id).currentSessionState,
    );
    this.renderConversationTabs();
    this.updateControls(false);
    await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    try {
      const { items, sessionId, started } = await this.ensureClientForTab(target.id);
      if (generation !== this.tabSwitchGeneration) {
        return;
      }
      this.showConversationMessages(target.id);
      if (items) {
        await this.renderHistorySession({ cwd: "", sessionId }, items, false);
      } else if (started) {
        this.resetConversationView(target.id);
        this.loadedMessageTabIds.add(target.id);
        this.appendSystemMessage("New Hermes conversation started.", false, target.id);
      }
      this.restoreActiveConversationRuntime();
      this.renderConversationTabs();
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    } catch (error) {
      new Notice(`Hermesian could not switch conversations: ${this.messageFor(error)}`);
    } finally {
      this.updateControls(false);
    }
  }

  private openModelPicker(): void {
    const state = this.activeSessionState();
    const activeTab = this.activeConversationTab();
    if (!activeTab || this.modelButtonEl.disabled || state.models.length === 0) {
      return;
    }
    new HermesModelSuggestModal(
      this.app,
      state.models,
      state.currentModel?.switchId,
      (model) => {
        void this.chooseModel(activeTab.id, model);
      },
    ).open();
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
    this.clientLoadingTabs.add(activeTab.id);
    this.updateControls(false);
    try {
      const sessions = await this.plugin.getClient(activeTab.id).listSessions();
      if (sessions.length === 0) {
        new Notice("No unarchived Hermes sessions were found in the current profile.");
        return;
      }
      new HermesHistorySuggestModal(this.app, sessions, (session) => {
        void this.chooseHistorySession(activeTab.id, session);
      }).open();
    } catch (error) {
      new Notice(`Hermesian history failed: ${this.messageFor(error)}`);
    } finally {
      this.clientLoadingTabs.delete(activeTab.id);
      this.updateControls(false);
    }
  }

  private async chooseHistorySession(
    tabId: string,
    session: HermesHistoryEntry,
  ): Promise<void> {
    const workspace = this.conversationWorkspace;
    const targetTab = workspace?.tabs.find((tab) => tab.id === tabId);
    if (!workspace || !targetTab || this.isTabBusy(tabId)) {
      return;
    }
    const existingOwner = workspace.tabs.find(
      (tab) => tab.id !== tabId && tab.sessionId === session.sessionId,
    );
    if (existingOwner) {
      await this.switchConversation(existingOwner.id);
      new Notice(`That Hermes session is already open in conversation ${existingOwner.label}.`);
      return;
    }
    this.captureActiveConversationRuntime();
    this.clientLoadingTabs.add(tabId);
    this.updateControls(false);
    try {
      const items = await this.plugin
        .getClient(tabId)
        .loadSessionHistory(session.sessionId);
      if (this.conversationWorkspace) {
        this.conversationWorkspace = replaceConversationSession(
          this.conversationWorkspace,
          tabId,
          session.sessionId,
        );
        await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
      }
      await this.renderHistorySession(session, items, true, tabId);
      this.turnRuntime(tabId).activeEditScope = undefined;
      this.renderConversationTabs();
    } catch (error) {
      new Notice(`Hermesian could not load that session: ${this.messageFor(error)}`);
    } finally {
      this.clientLoadingTabs.delete(tabId);
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
    new HermesReasoningSuggestModal(
      this.app,
      this.plugin.getReasoningEffort(),
      (effort) => {
        void this.chooseReasoningEffort(effort);
      },
    ).open();
  }

  private async chooseReasoningEffort(effort: ReasoningEffort): Promise<void> {
    if (effort === this.plugin.getReasoningEffort()) {
      return;
    }
    const activeTab = this.activeConversationTab();
    if (!activeTab || this.plugin.hasBusyClient()) {
      return;
    }
    this.captureActiveConversationRuntime();
    this.updateControls(true, false);
    try {
      await this.plugin.setReasoningEffort(activeTab.id, effort);
      await this.ensureClientForTab(activeTab.id);
      this.renderReasoningButton();
      this.appendSystemMessage(
        `Thinking depth set to ${reasoningEffortLabel(effort)}. The current Hermes session was restored.`,
        false,
        activeTab.id,
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
    this.sessionState = state;
    const availability = this.controlAvailability(state);
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
    if (this.composerEl.value.startsWith("/")) {
      this.renderSlashMenu(false);
    }
  }

  private renderSlashMenu(resetIndex: boolean): void {
    const value = this.composerEl.value;
    if (
      this.controlsBusy ||
      this.composerEl.selectionStart !== value.length ||
      this.composerEl.selectionEnd !== value.length
    ) {
      this.hideSlashMenu();
      return;
    }

    const previous = this.slashMenuItems[this.slashMenuIndex];
    const items = buildSlashMenuItems(
      value,
      this.sessionState.commands,
      this.sessionState.skills,
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
    const insertion = slashMenuInsertion(item);
    this.composerEl.value = insertion;
    this.composerEl.setSelectionRange(insertion.length, insertion.length);
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
      this.initializing ||
      this.controlsBusy ||
      this.isTabBusy(activeTab.id) ||
      this.clientLoadingTabs.has(activeTab.id) ||
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
    const rawRequest = this.composerEl.value.trim();
    const isSlashCommand = rawRequest.startsWith("/");
    const request =
      rawRequest ||
      (this.pendingSelection
        ? "请根据上下文改写选中的内容，使其更清晰、严谨，并保留原意。"
        : "");
    if (!request) {
      return;
    }

    const selection = isSlashCommand ? undefined : this.pendingSelection;
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
        : request;
    const runtime = this.turnRuntime(activeTab.id);
    runtime.activeEditScope = selection ?? documentContext;
    this.appendUserMessage(request, selection, documentContext);
    this.composerEl.value = "";
    this.hideSlashMenu();
    if (!isSlashCommand) {
      this.pendingSelection = undefined;
      this.renderSelectionBar();
    }
    this.captureActiveConversationRuntime();
    this.resetStreamingMessage(activeTab.id);
    runtime.busy = true;
    runtime.activeTurnEl = this.messagesEl.createDiv({ cls: "hermesian-turn" });
    this.loadedMessageTabIds.add(activeTab.id);
    this.renderConversationTabs();
    this.updateControls(false);

    try {
      await client.sendPrompt(
        isSlashCommand
          ? buildSlashOutboundPrompt(prompt)
          : `${prompt}\n\n${OBSIDIAN_OUTPUT_RULES}`,
      );
    } catch (error) {
      new Notice(`Hermesian: ${this.messageFor(error)}`);
      runtime.activeEditScope = undefined;
      await this.finishFailedTurn(activeTab.id);
    } finally {
      if (runtime.completionPromise) {
        await runtime.completionPromise;
      }
      runtime.busy = false;
      this.renderConversationTabs();
      if (this.conversationWorkspace?.activeTabId === activeTab.id) {
        this.updateControls(false);
      }
    }
  }

  async startNewSession(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (
      !activeTab ||
      this.controlsBusy ||
      this.isTabBusy(activeTab.id) ||
      this.activeSessionState().switchingModel ||
      this.hasPendingPermission(activeTab.id)
    ) {
      return;
    }
    this.captureActiveConversationRuntime();
    this.clientLoadingTabs.add(activeTab.id);
    this.updateControls(false);
    try {
      const client = this.plugin.getClient(activeTab.id);
      await client.newSession();
      const sessionId = client.sessionId;
      if (!sessionId) {
        throw new Error("Hermes ACP did not return a new session ID");
      }
      this.conversationWorkspace = replaceConversationSession(
        this.conversationWorkspace!,
        activeTab.id,
        sessionId,
      );
      this.resetConversationView(activeTab.id);
      this.turnRuntime(activeTab.id).activeEditScope = undefined;
      this.appendSystemMessage("New Hermes session started.", false, activeTab.id);
      this.renderConversationTabs();
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    } catch (error) {
      new Notice(`Hermesian: ${this.messageFor(error)}`);
    } finally {
      this.clientLoadingTabs.delete(activeTab.id);
      this.updateControls(false);
    }
  }

  private appendUserMessage(
    text: string,
    selection?: SelectionContext,
    documentContext?: MarkdownDocumentContext,
    tabId = this.conversationWorkspace?.activeTabId,
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
    this.scrollToBottom(tabId);
  }

  private appendAssistantDelta(tabId: string, text: string): void {
    const runtime = this.turnRuntime(tabId);
    this.ensureTurnActivity(tabId);
    if (!runtime.assistantContentEl) {
      const message = runtime.activeTurnEl!.createDiv({
        cls: "hermesian-message is-assistant",
      });
      runtime.assistantContentEl = message.createDiv({
        cls: "hermesian-message-content is-streaming",
      });
    }
    runtime.assistantText += text;
    runtime.assistantContentEl.setText(runtime.assistantText);
    this.scrollToBottom(tabId);
  }

  private appendThoughtDelta(tabId: string, text: string): void {
    const runtime = this.turnRuntime(tabId);
    if (!runtime.thoughtContentEl) {
      const details = this.ensureTurnActivity(tabId).createEl("details", {
        cls: "hermesian-thought",
      });
      details.open = true;
      details.createEl("summary", { text: "Thinking" });
      runtime.thoughtContentEl = details.createEl("pre");
    }
    runtime.thoughtContentEl.textContent = `${runtime.thoughtContentEl.textContent ?? ""}${text}`;
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
    await this.renderMarkdown(target, text, runtime.activeEditScope?.filePath);
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
      text,
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
    return this.visibleMessagesTabId === tabId
      ? this.messagesEl
      : this.ensureMessageCache(tabId);
  }

  private ensureTurnActivity(tabId: string): HTMLElement {
    const runtime = this.turnRuntime(tabId);
    if (!runtime.activeTurnEl) {
      runtime.activeTurnEl = this.messageContainer(tabId).createDiv({
        cls: "hermesian-turn",
      });
    }
    if (!runtime.turnActivityEl) {
      runtime.turnActivityEl = runtime.activeTurnEl.createDiv({
        cls: "hermesian-turn-activity",
      });
    }
    return runtime.turnActivityEl;
  }

  private async finishTurn(tabId: string, reason: string): Promise<void> {
    return this.completeTurn(tabId, async () => {
      await this.finalizeAssistantMessage(tabId);
      this.appendStopReason(tabId, reason);
    });
  }

  private async finishFailedTurn(tabId: string): Promise<void> {
    return this.completeTurn(tabId, () => this.finalizeAssistantMessage(tabId));
  }

  private completeTurn(tabId: string, finalize: () => Promise<void>): Promise<void> {
    const runtime = this.turnRuntime(tabId);
    if (runtime.completionPromise) {
      return runtime.completionPromise;
    }
    const completion = this.completeTurnInternal(tabId, finalize);
    runtime.completionPromise = completion;
    void completion.finally(() => {
      if (runtime.completionPromise === completion) {
        runtime.completionPromise = undefined;
      }
    });
    return completion;
  }

  private async completeTurnInternal(
    tabId: string,
    finalize: () => Promise<void>,
  ): Promise<void> {
    const runtime = this.turnRuntime(tabId);
    try {
      await finalize();
    } catch (error) {
      new Notice(`Hermesian could not finalize the response: ${this.messageFor(error)}`);
    } finally {
      runtime.busy = false;
      runtime.activeTurnEl = undefined;
      runtime.turnActivityEl = undefined;
      runtime.thoughtContentEl = undefined;
      this.renderConversationTabs();
      if (this.conversationWorkspace?.activeTabId === tabId) {
        this.updateControls(false);
      }
    }
  }

  private resetStreamingMessage(tabId: string): void {
    const runtime = this.turnRuntime(tabId);
    runtime.assistantContentEl = undefined;
    runtime.assistantText = "";
    runtime.thoughtContentEl = undefined;
  }

  private resetConversationView(tabId: string): void {
    this.messageContainer(tabId).empty();
    const runtime = this.turnRuntime(tabId);
    runtime.toolEls.clear();
    this.resetStreamingMessage(tabId);
    runtime.activeTurnEl = undefined;
    runtime.turnActivityEl = undefined;
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
    const runtime = tabId ? this.turnRuntimes.get(tabId) : undefined;
    const parent = tabId
      ? runtime?.activeTurnEl
        ? this.ensureTurnActivity(tabId)
        : this.messageContainer(tabId)
      : this.messagesEl;
    const message = parent.createDiv({
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

  private updateControls(busy: boolean, _showStop = busy): void {
    this.controlsBusy = conversationControlsBusy(busy, this.initializing);
    if (this.controlsBusy) {
      this.hideSlashMenu();
    }
    const availability = this.controlAvailability();
    this.sendButtonEl.disabled = !availability.send;
    this.composerEl.disabled = !availability.composer;
    this.renderAddConversationControl();
    this.historyButtonEl.disabled = !availability.history;
    this.reasoningButtonEl.disabled = !availability.reasoning;
    this.renderConversationTabs();
    this.renderSessionState(this.activeSessionState());
    this.updateComposerPlaceholder();
    if (availability.stop) {
      this.sendButtonEl.hide();
      this.stopButtonEl.show();
    } else {
      this.stopButtonEl.hide();
      this.sendButtonEl.show();
      if (!this.controlsBusy) {
        this.composerEl.focus();
      }
    }
  }

  private updateComposerPlaceholder(): void {
    const activeTabId = this.conversationWorkspace?.activeTabId;
    this.composerEl.placeholder =
      activeTabId && this.clientLoadingTabs.has(activeTabId)
        ? "Draft here — this conversation is starting"
        : "Ask Hermes…  ↵ to send · Shift+↵ for new line";
  }

  private scrollToBottom(sourceTabId?: string): void {
    window.requestAnimationFrame(() => {
      if (!shouldAutoScrollConversation(this.visibleMessagesTabId, sourceTabId)) {
        return;
      }
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function requestHasRawContent(contents: ToolCallContent[]): boolean {
  return contents.length > 0;
}
