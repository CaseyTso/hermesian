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
  contextUsageLevel,
  contextUsagePercent,
  formatContextUsage,
} from "./session-state";
import {
  buildDocumentPrompt,
  buildSelectionPrompt,
  validateSelectionEdit,
} from "./selection-context";
import type {
  HermesModelOption,
  HermesSessionState,
  HermesUiEvent,
  MarkdownDocumentContext,
  SelectionContext,
} from "./types";
import type { PermissionRequest } from "./acp-client";

export const HERMESIAN_VIEW_TYPE = "hermesian-sidebar";

interface PendingPermission {
  card: HTMLElement;
  resolve: (response: RequestPermissionResponse) => void;
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

export class HermesianSidebarView extends ItemView {
  private activeEditScope: SelectionContext | undefined;
  private assistantContentEl: HTMLElement | undefined;
  private assistantText = "";
  private composerEl!: HTMLTextAreaElement;
  private contextProgressEl!: HTMLElement;
  private contextUsageEl!: HTMLElement;
  private controlsBusy = false;
  private currentFileBarEl!: HTMLElement;
  private currentFileLabelEl!: HTMLElement;
  private currentFilePath: string | undefined;
  private messagesEl!: HTMLElement;
  private modelButtonEl!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private pendingSelection: SelectionContext | undefined;
  private readonly permissions = new Map<string, PendingPermission>();
  private selectionBarEl!: HTMLElement;
  private sendButtonEl!: HTMLButtonElement;
  private sessionState: HermesSessionState = {
    catalogLoading: false,
    models: [],
    switchingModel: false,
  };
  private statusEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private thoughtContentEl: HTMLElement | undefined;
  private readonly toolEls = new Map<string, HTMLElement>();
  private unsubscribeSessionState: (() => void) | undefined;

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
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    this.plugin.attachView(this);
    this.unsubscribeSessionState = this.plugin
      .getClient()
      .onSessionState((state) => this.renderSessionState(state));
    try {
      await this.plugin.getClient().connect();
    } catch (error) {
      new Notice(`Hermesian connection failed: ${this.messageFor(error)}`);
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribeSessionState?.();
    this.unsubscribeSessionState = undefined;
    for (const permission of this.permissions.values()) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    await this.plugin.releaseView(this);
  }

  setSelection(context: SelectionContext): void {
    this.pendingSelection = context;
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

  handleHermesEvent(event: HermesUiEvent): void {
    switch (event.type) {
      case "status":
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
        this.appendAssistantDelta(event.text);
        return;
      case "thought-delta":
        this.appendThoughtDelta(event.text);
        return;
      case "tool":
        this.renderToolEvent(event);
        return;
      case "notice":
        this.appendSystemMessage(event.text);
        return;
      case "error":
        this.activeEditScope = undefined;
        this.appendSystemMessage(`Error: ${event.message}`, true);
        this.updateControls(false);
        return;
      case "turn-stop":
        this.activeEditScope = undefined;
        void this.finalizeAssistantMessage();
        this.appendStopReason(event.reason);
        this.updateControls(false);
        return;
    }
  }

  requestPermission(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
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
      const validation = validateSelectionEdit(this.activeEditScope, diffs);
      if (validation.allowed === false) {
        this.appendSystemMessage(`Blocked edit: ${validation.reason}`, true);
        return Promise.resolve(rejectionFor(request.options));
      }
    }
    if (signal.aborted) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      const card = this.messagesEl.createDiv({ cls: "hermesian-permission" });
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
        if (!this.permissions.has(request.toolCall.toolCallId)) {
          return;
        }
        this.permissions.delete(request.toolCall.toolCallId);
        actions.querySelectorAll("button").forEach((button) => {
          (button as HTMLButtonElement).disabled = true;
        });
        card.addClass("is-resolved");
        resolve(response);
      };

      for (const option of request.options) {
        this.addPermissionButton(actions, option, finish);
      }

      this.permissions.set(request.toolCall.toolCallId, { card, resolve });
      const onAbort = (): void => {
        finish({ outcome: { outcome: "cancelled" } });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
      this.scrollToBottom();
    });
  }

  private renderShell(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("hermesian-view");

    const header = root.createDiv({ cls: "hermesian-header" });
    const identity = header.createDiv({ cls: "hermesian-identity" });
    const logo = identity.createSpan({ cls: "hermesian-logo" });
    setIcon(logo, "bot");
    identity.createSpan({ text: "Hermesian", cls: "hermesian-title" });
    this.statusEl = identity.createSpan({
      text: "Disconnected",
      cls: "hermesian-status",
    });

    const headerActions = header.createDiv({ cls: "hermesian-header-actions" });
    const newSessionButton = headerActions.createEl("button", {
      attr: { "aria-label": "New Hermes session" },
      cls: "clickable-icon",
    });
    setIcon(newSessionButton, "square-pen");
    newSessionButton.addEventListener("click", () => {
      void this.startNewSession();
    });

    this.messagesEl = root.createDiv({ cls: "hermesian-messages" });
    this.appendSystemMessage(
      "Select text in a Markdown note, run “Ask Hermes about selection”, then describe the change you want.",
    );

    this.currentFileBarEl = root.createDiv({ cls: "hermesian-current-file" });
    const currentFileIcon = this.currentFileBarEl.createSpan({
      cls: "hermesian-current-file-icon",
    });
    setIcon(currentFileIcon, "file-text");
    this.currentFileLabelEl = this.currentFileBarEl.createSpan({
      cls: "hermesian-current-file-label",
    });
    this.renderCurrentFile();

    const sessionBar = root.createDiv({ cls: "hermesian-session-bar" });
    this.modelButtonEl = sessionBar.createEl("button", {
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

    const context = sessionBar.createDiv({ cls: "hermesian-context" });
    this.contextUsageEl = context.createDiv({
      text: "Context —",
      cls: "hermesian-context-label",
    });
    const contextTrack = context.createDiv({ cls: "hermesian-context-track" });
    this.contextProgressEl = contextTrack.createDiv({
      cls: "hermesian-context-progress",
    });

    const composer = root.createDiv({ cls: "hermesian-composer" });
    this.selectionBarEl = composer.createDiv({ cls: "hermesian-selection-bar" });
    this.selectionBarEl.hide();

    this.composerEl = composer.createEl("textarea", {
      attr: {
        "aria-label": "Message Hermes",
        placeholder: "Ask Hermes…  ⌘↵ to send",
        rows: "3",
      },
      cls: "hermesian-input",
    });
    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.sendMessage();
      }
    });

    const composerActions = composer.createDiv({ cls: "hermesian-composer-actions" });
    const addSelectionButton = composerActions.createEl("button", {
      text: "Add selection",
    });
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

    const rightActions = composerActions.createDiv({ cls: "hermesian-send-actions" });
    this.stopButtonEl = rightActions.createEl("button", {
      text: "Stop",
      cls: "mod-warning",
    });
    this.stopButtonEl.hide();
    this.stopButtonEl.addEventListener("click", () => {
      void this.plugin.getClient().cancel();
    });

    this.sendButtonEl = rightActions.createEl("button", {
      text: "Send",
      cls: "mod-cta",
    });
    this.sendButtonEl.addEventListener("click", () => {
      void this.sendMessage();
    });
  }

  private openModelPicker(): void {
    if (this.modelButtonEl.disabled || this.sessionState.models.length === 0) {
      return;
    }
    new HermesModelSuggestModal(
      this.app,
      this.sessionState.models,
      this.sessionState.currentModel?.switchId,
      (model) => {
        void this.chooseModel(model);
      },
    ).open();
  }

  private async chooseModel(model: HermesModelOption): Promise<void> {
    try {
      await this.plugin.getClient().setModel(model);
    } catch (error) {
      new Notice(`Hermesian model switch failed: ${this.messageFor(error)}`);
    }
  }

  private renderSessionState(state: HermesSessionState): void {
    this.sessionState = state;
    const current = state.currentModel;
    const label = state.switchingModel
      ? "Switching model…"
      : current
        ? `${current.providerName} · ${current.name}`
        : state.catalogLoading
          ? "Loading models…"
          : "Model unavailable";
    this.modelLabelEl.setText(label);
    this.modelButtonEl.disabled =
      this.controlsBusy || state.switchingModel || state.models.length === 0;
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
  }

  private renderCurrentFile(): void {
    const label = this.currentFilePath
      ? `Current note: ${this.currentFilePath}`
      : "Current note: none";
    this.currentFileLabelEl.setText(label);
    this.currentFileBarEl.setAttribute("title", label);
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
    });
  }

  private async sendMessage(): Promise<void> {
    const rawRequest = this.composerEl.value.trim();
    const request =
      rawRequest ||
      (this.pendingSelection
        ? "请根据上下文改写选中的内容，使其更清晰、严谨，并保留原意。"
        : "");
    if (!request) {
      return;
    }

    const selection = this.pendingSelection;
    const documentContext = selection
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
    this.activeEditScope = selection;
    this.appendUserMessage(request, selection, documentContext);
    this.composerEl.value = "";
    this.pendingSelection = undefined;
    this.renderSelectionBar();
    this.resetStreamingMessage();
    this.updateControls(true);

    try {
      await this.plugin.getClient().sendPrompt(prompt);
    } catch (error) {
      new Notice(`Hermesian: ${this.messageFor(error)}`);
      this.activeEditScope = undefined;
      this.updateControls(false);
    }
  }

  private async startNewSession(): Promise<void> {
    try {
      await this.plugin.getClient().newSession();
      this.messagesEl.empty();
      this.toolEls.clear();
      this.resetStreamingMessage();
      this.activeEditScope = undefined;
      this.appendSystemMessage("New Hermes session started.");
    } catch (error) {
      new Notice(`Hermesian: ${this.messageFor(error)}`);
    }
  }

  private appendUserMessage(
    text: string,
    selection?: SelectionContext,
    documentContext?: MarkdownDocumentContext,
  ): void {
    const message = this.messagesEl.createDiv({
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
    this.scrollToBottom();
  }

  private appendAssistantDelta(text: string): void {
    if (!this.assistantContentEl) {
      const message = this.messagesEl.createDiv({
        cls: "hermesian-message is-assistant",
      });
      this.assistantContentEl = message.createDiv({
        cls: "hermesian-message-content",
      });
    }
    this.assistantText += text;
    this.assistantContentEl.setText(this.assistantText);
    this.scrollToBottom();
  }

  private appendThoughtDelta(text: string): void {
    if (!this.thoughtContentEl) {
      const details = this.messagesEl.createEl("details", {
        cls: "hermesian-thought",
      });
      details.createEl("summary", { text: "Thinking" });
      this.thoughtContentEl = details.createEl("pre");
    }
    this.thoughtContentEl.textContent = `${this.thoughtContentEl.textContent ?? ""}${text}`;
  }

  private async finalizeAssistantMessage(): Promise<void> {
    const target = this.assistantContentEl;
    const text = this.assistantText;
    this.assistantContentEl = undefined;
    this.assistantText = "";
    this.thoughtContentEl = undefined;
    if (!target || !text) {
      return;
    }
    target.empty();
    await MarkdownRenderer.render(this.app, text, target, "", this);
    this.scrollToBottom();
  }

  private resetStreamingMessage(): void {
    this.assistantContentEl = undefined;
    this.assistantText = "";
    this.thoughtContentEl = undefined;
  }

  private renderToolEvent(event: Extract<HermesUiEvent, { type: "tool" }>): void {
    let element = this.toolEls.get(event.id);
    if (!element) {
      element = this.messagesEl.createDiv({ cls: "hermesian-tool" });
      this.toolEls.set(event.id, element);
    }
    element.empty();
    const icon = element.createSpan();
    setIcon(icon, event.kind === "edit" ? "file-pen-line" : "wrench");
    element.createSpan({ text: event.title, cls: "hermesian-tool-title" });
    element.createSpan({
      text: event.status ?? "pending",
      cls: "hermesian-tool-status",
    });
    this.scrollToBottom();
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

  private appendSystemMessage(text: string, error = false): void {
    const message = this.messagesEl.createDiv({
      cls: `hermesian-system${error ? " is-error" : ""}`,
    });
    message.setText(text);
    this.scrollToBottom();
  }

  private appendStopReason(reason: string): void {
    if (reason !== "end_turn") {
      this.appendSystemMessage(`Turn stopped: ${reason}`);
    }
  }

  private updateControls(busy: boolean): void {
    this.controlsBusy = busy;
    this.sendButtonEl.disabled = busy;
    this.composerEl.disabled = busy;
    this.renderSessionState(this.sessionState);
    if (busy) {
      this.stopButtonEl.show();
    } else {
      this.stopButtonEl.hide();
      this.composerEl.focus();
    }
  }

  private scrollToBottom(): void {
    window.requestAnimationFrame(() => {
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
