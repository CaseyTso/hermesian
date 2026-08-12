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
  type SteerableDraftFacts,
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
import { normalizeTableSpacing } from "./markdown-table";
import {
  contextUsageLevel,
  contextUsagePercent,
  formatContextUsage,
} from "./session-state";
import {
  buildOutboundPrompt,
  resolveNoteContextInjection,
  validateSelectionEdit,
  type NoteContextFingerprint,
  type NoteContextInjectionKind,
} from "./selection-context";
import { reasoningEffortLabel } from "./session-history";
import { HermesHistorySuggestModal } from "./ui/conversation-modals";
import { HermesModelPickerPopover } from "./ui/model-picker-popover";
import { HermesReasoningPickerPopover } from "./ui/reasoning-picker-popover";
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
import { ScrollFollowController } from "./ui/scroll-lock";
import {
  applyComposerSlashToken,
  applyComposerState,
  createComposerView,
  type ComposerCallbacks,
  type ComposerState,
} from "./ui/composer-view";
import {
  composerInlineDraftRouting,
  composerInlineDraftIsSlashCommand,
  removeInlineReference,
  restoreComposerInlineDraft,
  serializeComposerInlineDraft,
  type ComposerInlineDraft,
  type InlineReference,
  type ReferenceToken,
} from "./composer-reference-tokens";
import {
  applyInlineCut,
  getCaretOffset,
  handleInlineEditorKeydown,
  handleInlineEditorPaste,
  inlineCutPayload,
  insertTextAtCaret,
  renderInlineDraft,
  setCaretOffset,
  type InlineEditorRenderOptions,
} from "./composer-inline-editor";
import {
  buildSlashMenuItems,
  composerSlashTokenFromMenuItem,
  serializeComposerSlashDraft,
  slashMenuInsertion,
  type ComposerSlashToken,
  type SlashMenuItem,
} from "./slash-menu";
import { buildEnvelopePrompt, stripEnvelopeFromPrompt } from "./outbound-envelope";
import {
  composerPrimaryMode,
  composerStopIntent,
  composerSubmitIntent,
  dictationAudioTooShort,
  focusOwnsEscape,
  preferredMediaRecorderMimeType,
  shouldStopOnEscape,
  steerableDraftFactsFromComposer,
  type DictationUiPhase,
} from "./composer-actions";
import {
  DictationBridge,
  type DictationResult,
} from "./dictation-bridge";
import {
  assertStopAndSendCanSend,
  continuedDraftAfterStopAndSend,
  isStopAndSendUiBlocking,
  StopAndSendCoordinator,
  type StopAndSendPhase,
} from "./stop-and-send";
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
  type SteerResult,
} from "./types";
import {
  HermesAcpClient,
  resolveHermesExecutable,
  type PermissionRequest,
} from "./acp-client";
import { ViewStartupCoordinator } from "./view-startup";

export const HERMESIAN_VIEW_TYPE = "hermesian-sidebar";

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
    steer: false,
    stop: false,
    tabNavigation: false,
  });

function steerFailureMessage(reason: string): string {
  switch (reason) {
    case "queued":
      return "Steer was queued by Hermes instead of applying to the active turn. Draft kept.";
    case "steer_failed":
      return "Steer failed. Draft kept.";
    case "unverifiable":
      return "Steer could not be verified. Draft kept.";
    case "no_active_turn":
      return "No active turn to steer.";
    case "steer_in_flight":
      return "A steer is already in progress.";
    default:
      return `Steer failed: ${reason}`;
  }
}

function dictationFailureMessage(result: Extract<DictationResult, { ok: false }>): string {
  switch (result.reason) {
    case "unsupported_format":
      return "Dictation format is not supported by this browser.";
    case "file_too_large":
      return "Recording is too large to transcribe.";
    case "empty_audio":
      return "Recording was empty — nothing to transcribe.";
    case "python_unavailable":
      return "Hermes venv python is unavailable for dictation.";
    case "spawn_failed":
      return "Could not start dictation transcription.";
    case "timeout":
      return "Dictation transcription timed out.";
    case "invalid_output":
      return "Dictation returned invalid output.";
    case "transcription_failed":
      return result.detail?.trim()
        ? `Dictation failed: ${result.detail}`
        : "Dictation transcription failed.";
    default:
      return "Dictation failed.";
  }
}

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
  private composerEl!: HTMLElement;
  private composerDraft: ComposerInlineDraft = {
    token: null,
    text: "",
    references: [],
  };
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
  private scrollFollow!: ScrollFollowController;
  private turnManager!: TurnManager;
  private readonly editScopes = new Map<
    string,
    SelectionContext | MarkdownDocumentContext | undefined
  >();
  private readonly pendingImages = new Map<string, PastedImageAttachment[]>();
  private reasoningButtonEl!: HTMLButtonElement;
  private reasoningLabelEl!: HTMLElement;
  private reasoningPicker: HermesReasoningPickerPopover | null = null;
  private selectionBarEl!: HTMLElement;
  private sendButtonEl!: HTMLButtonElement;
  private steerButtonEl!: HTMLButtonElement;
  private dictationButtonEl!: HTMLButtonElement;
  private composerHintEl!: HTMLElement;
  private composerStatusEl!: HTMLElement;
  private slashMenuEl!: HTMLElement;
  private slashTokenEl!: HTMLElement;
  private slashTokenIconEl!: HTMLElement;
  private slashTokenLabelEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private readonly tabSelections = new Map<string, SelectionContext | undefined>();
  /** Per-tab in-memory fingerprint of the last note context actually sent
   *  ({filePath, documentHash}); drives the full/changed/none dedupe. Never
   *  persisted to plugin data. A path with only an active-note marker is
   *  recorded with an empty hash. */
  private readonly noteContextFingerprints = new Map<string, NoteContextFingerprint>();
  private slashMenuIndex = 0;
  private slashMenuItems: SlashMenuItem[] = [];
  private statusEl!: HTMLElement;
  private startup: ViewStartupCoordinator | undefined;
  private startupStatusClickBound = false;
  /** Ephemeral composer hint (steer reject, STT error). Cleared on next draft change. */
  private composerHint: string | undefined;
  /** True while a pure-text steer request is outstanding (disables Steer). */
  private steerInFlight = false;
  private dictationPhase: DictationUiPhase = "idle";
  private mediaRecorder: MediaRecorder | undefined;
  private mediaStream: MediaStream | undefined;
  private mediaChunks: BlobPart[] = [];
  private dictationBridge: DictationBridge | undefined;
  private stopAndSend: StopAndSendCoordinator | undefined;
  private escapeKeyBound = false;

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
    this.bindEscapeToStop();
    this.ensureConversationController();
    this.ensureStopAndSendCoordinator();
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
    this.reasoningPicker?.detach();
    this.reasoningPicker = null;
    this.startup?.close();
    this.startup = undefined;
    this.teardownDictationRecording();
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

  /** Seeds a tab's dedupe fingerprint with the *current* note (path+hash,
   *  empty hash when only the active-note marker is available). Used after a
   *  successful session resume so the next same-path request is deduped;
   *  nothing is sent here. */
  private seedNoteContextFingerprint(tabId: string): void {
    const doc = this.plugin.getCurrentDocumentContext();
    if (doc) {
      this.noteContextFingerprints.set(tabId, {
        filePath: doc.filePath,
        documentHash: doc.documentHash,
      });
      return;
    }
    const path = this.plugin.getCurrentMarkdownFilePath();
    if (path) {
      this.noteContextFingerprints.set(tabId, {
        filePath: path,
        documentHash: "",
      });
    } else {
      this.noteContextFingerprints.delete(tabId);
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
    this.scrollFollow = new ScrollFollowController();
    this.messageRenderer = new MessageRenderer(this.messagesEl, {
      scrollFollow: this.scrollFollow,
    });

    const turnCallbacks: TurnCallbacks = {
      onTurnComplete: (tabId: string) => {
        // Clear controller prompt before stop-and-send waiters wake so the
        // follow-up send does not see a stale "busy" / send-unavailable guard.
        this.controller?.setPromptRunning(tabId, false);
        this.renderConversationTabs();
        if (this.conversationWorkspace?.activeTabId === tabId) {
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
      getDraft: () => this.composerDraft,
      onDraftChange: (draft: ComposerInlineDraft) => {
        this.composerDraft = draft;
        if (this.composerHint) {
          this.composerHint = undefined;
        }
        this.renderSlashMenu(true);
        this.captureActiveConversationRuntime();
        // Live re-derive Stop/Steer visibility while typing during an Active Turn.
        this.updateControls(false);
      },
      onPaste: (event: ClipboardEvent) => {
        void this.handleComposerPaste(event);
      },
      onSend: () => {
        void this.handleComposerSubmit();
      },
      onSteer: () => {
        void this.handleComposerSubmit();
      },
      onStop: () => {
        void this.handleComposerStop();
      },
      onDictation: () => {
        void this.handleDictationToggle();
      },
      onKeydown: (event: KeyboardEvent) => {
        if (this.handleSlashMenuKeydown(event)) {
          return;
        }
        const result = handleInlineEditorKeydown(
          this.composerEl,
          event,
          this.composerDraft,
          this.inlineRenderOptions(),
        );
        if (!result.handled) {
          return;
        }
        event.preventDefault();
        if (result.draft) {
          this.composerDraft = result.draft;
          this.composerHint = undefined;
          this.captureActiveConversationRuntime();
          this.updateControls(false);
        }
        if (result.sendRequested) {
          void this.handleComposerSubmit();
        } else if (result.slashClearRequested) {
          this.setComposerSlashToken(null);
          this.captureActiveConversationRuntime();
          this.renderSlashMenu(true);
          this.composerEl.focus();
        }
      },
      onCopy: (event: ClipboardEvent) => {
        const payload = inlineCutPayload(this.composerEl, this.composerDraft);
        if (payload === null) {
          return;
        }
        event.preventDefault();
        event.clipboardData?.setData("text/plain", payload);
      },
      onCut: (event: ClipboardEvent) => {
        const result = applyInlineCut(
          this.composerEl,
          this.composerDraft,
          this.inlineRenderOptions(),
        );
        if (!result.handled) {
          return;
        }
        event.preventDefault();
        event.clipboardData?.setData("text/plain", result.payload ?? "");
        this.composerDraft = result.draft!;
        this.captureActiveConversationRuntime();
        this.updateControls(false);
      },
      onReferenceRemove: (index: number) => {
        this.removeComposerReference(index);
      },
      renderIcon: (iconEl, kind) => {
        setIcon(iconEl, kind === "url" ? "link" : "file");
      },
    };

    const initialComposerState: ComposerState = {
      disabled: true,
      draft: { token: null, text: "", references: [] },
      placeholder: "Ask Hermes…  ↵ to send · Shift+↵ for new line",
      sendEnabled: false,
      stopVisible: false,
      primaryMode: "send",
      dictationPhase: "idle",
      dictationEnabled: false,
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
    this.steerButtonEl = composerElements.steerButtonEl;
    this.stopButtonEl = composerElements.stopButtonEl;
    this.dictationButtonEl = composerElements.dictationButtonEl;
    this.composerHintEl = composerElements.hintEl;
    this.composerStatusEl = composerElements.statusEl;
    this.contextProgressEl = composerElements.contextProgressEl;
    this.contextUsageEl = composerElements.contextUsageEl;

    // Wire icons (needs Obsidian's setIcon)
    setIcon(composerElements.currentFileBarEl.querySelector(".hermesian-current-file-icon")!, "file-text");
    setIcon(composerElements.modelButtonEl.querySelector(".hermesian-model-icon")!, "bot");
    setIcon(composerElements.modelButtonEl.querySelector(".hermesian-model-chevron")!, "chevron-down");
    setIcon(composerElements.reasoningButtonEl.querySelector(".hermesian-reasoning-icon")!, "brain");
    setIcon(composerElements.addSelectionButtonEl.querySelector("span")!, "paperclip");
    setIcon(composerElements.dictationButtonEl.querySelector("span")!, "mic");
    setIcon(composerElements.sendButtonEl.querySelector("span")!, "arrow-right");
    setIcon(composerElements.steerButtonEl.querySelector("span")!, "corner-down-left");
    setIcon(composerElements.stopButtonEl.querySelector("span")!, "square");
    this.setComposerSlashToken(null);
    this.renderComposerInlineDraft();

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

  private liveSteerableDraftFacts(): SteerableDraftFacts {
    const activeTabId = this.conversationWorkspace?.activeTabId;
    return steerableDraftFactsFromComposer({
      draft: this.composerDraft,
      hasPendingImages: activeTabId
        ? (this.pendingImages.get(activeTabId)?.length ?? 0) > 0
        : false,
      hasPendingSelection: Boolean(this.pendingSelection),
    });
  }

  private controlAvailability() {
    if (!this.controller) {
      return DISABLED_CONVERSATION_CONTROLS;
    }
    // Live draft facts stay on the view; derivation stays on the controller.
    return this.controller.getActiveControlAvailability(this.liveSteerableDraftFacts());
  }

  private tabControlAvailability(tabId: string) {
    return (
      this.controller?.getSnapshot().controls.byTab.get(tabId) ??
      DISABLED_CONVERSATION_CONTROLS
    );
  }

  private stopAndSendPhase(): StopAndSendPhase {
    return this.stopAndSend?.getState().phase ?? "idle";
  }

  private isStopping(): boolean {
    return isStopAndSendUiBlocking(this.stopAndSendPhase());
  }

  private ensureStopAndSendCoordinator(): void {
    if (this.stopAndSend) {
      return;
    }
    this.stopAndSend = new StopAndSendCoordinator(async (draft, hooks) => {
      // Barrier already waited for main-turn terminal. Capture any text typed
      // while Stopping…, load the snapshot only long enough for sendMessage to
      // consume it into the outbound prompt, then restore continued draft and
      // leave Stopping… at dispatch — never hold waiting for the whole next turn.
      const continuedDraft = this.getComposerCanonicalDraft();
      this.applyComposerCanonicalDraft(draft);
      this.composerHint = undefined;
      this.updateControls(false);
      try {
        await this.sendMessage({
          fromStopAndSend: true,
          restoreComposerAfterDispatch: continuedDraftAfterStopAndSend(continuedDraft),
          onStopAndSendDispatched: hooks.onDispatched,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Pre-dispatch failure: coordinator still has snapshot for restore.
        // Post-dispatch failure: snapshot already cleared; normal send path owns UX.
        const snapshot = this.stopAndSend?.getState().snapshot;
        if (snapshot?.draft) {
          this.applyComposerCanonicalDraft(snapshot.draft);
        }
        this.composerHint = message;
        this.updateControls(false);
        new Notice(`Hermesian stop-and-send failed: ${message}`);
        throw error instanceof Error ? error : new Error(message);
      }
    });
  }

  private ensureDictationBridge(): DictationBridge {
    if (!this.dictationBridge) {
      this.dictationBridge = new DictationBridge({
        debugLogging: this.plugin.settings.debugLogging,
        hermesExecutable: resolveHermesExecutable(this.plugin.settings.hermesExecutable),
        profile: this.plugin.settings.profile,
      });
    }
    return this.dictationBridge;
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
      token: this.composerDraft.token ?? undefined,
      references: this.composerDraft.references,
    });
    this.plugin.setConversationWorkspace(this.conversationWorkspace);
  }

  private restoreActiveConversationRuntime(): void {
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    this.applyComposerCanonicalDraft(activeTab.draft, activeTab.token, activeTab.references);
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
      this.noteContextFingerprints.delete(result.tabId);
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
      this.noteContextFingerprints.delete(tabId);
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
          this.seedNoteContextFingerprint(ownerId);
        } else if (result.started) {
          this.resetConversationView(ownerId);
          this.loadedMessageTabIds.add(ownerId);
          this.noteContextFingerprints.delete(ownerId);
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
        this.seedNoteContextFingerprint(result.tabId);
      } else if (result.started) {
        this.resetConversationView(result.tabId);
        this.loadedMessageTabIds.add(result.tabId);
        this.noteContextFingerprints.delete(result.tabId);
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
    this.reasoningPicker?.detach();
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
        this.seedNoteContextFingerprint(result.tabId);
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
      this.seedNoteContextFingerprint(result.tabId);
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
    if (this.reasoningPicker) {
      // Repeat click on the thinking button toggles the popover closed.
      this.reasoningPicker.detach();
      return;
    }
    this.modelPicker?.detach();
    const targetTabId = activeTab.id;
    let settled = false;

    this.reasoningPicker = new HermesReasoningPickerPopover({
      anchorEl: this.reasoningButtonEl,
      current: this.plugin.getReasoningEffort(),
      iconRenderer: (element, icon) => setIcon(element, icon),
      onChoose: (effort) => {
        if (settled) {
          return;
        }
        settled = true;
        void this.chooseReasoningEffort(targetTabId, effort);
      },
      onClose: () => {
        this.reasoningPicker = null;
      },
    });
    this.reasoningPicker.open();
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
    if (this.composerInlineDraftIsSlashCommand()) {
      this.renderSlashMenu(false);
    }
  }

  private renderSlashMenu(resetIndex: boolean): void {
    const value = this.getComposerSlashMenuValue();
    if (
      !this.controlAvailability().composer ||
      getCaretOffset(this.composerEl) !== this.composerDraft.text.length
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
      this.composerDraft = { token, text: "", references: [] };
      this.renderComposerInlineDraft();
    } else {
      // skill-loader and any non-token items keep plain insertion text
      this.setComposerSlashToken(null);
      const insertion = slashMenuInsertion(item);
      this.composerDraft = {
        token: null,
        text: insertion,
        references: [],
      };
      this.renderComposerInlineDraft();
      setCaretOffset(this.composerEl, insertion.length);
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
      // No image on the clipboard: the adapter replaces the selection with a
      // capsule for a whole-paste URL/absolute path, or plain text otherwise.
      const result = handleInlineEditorPaste(
        this.composerEl,
        event,
        this.composerDraft,
        this.inlineRenderOptions(),
      );
      if (result.handled && result.draft) {
        event.preventDefault();
        this.composerDraft = result.draft;
        this.captureActiveConversationRuntime();
      }
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

  private async sendMessage(
    options: {
      fromStopAndSend?: boolean;
      /** Restore this composer text right after outbound dispatch, before the turn awaits. */
      restoreComposerAfterDispatch?: string;
      /**
       * Stop-and-send: fire once the snapshot is on the outbound wire so the
       * coordinator can leave Stopping… before await sendPrompt.
       */
      onStopAndSendDispatched?: () => void;
    } = {},
  ): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (options.fromStopAndSend) {
      // Stop-and-send must never silent-return: coordinator would mark success
      // and drop the snapshot. Throw so send-failed restores + surfaces error.
      assertStopAndSendCanSend({
        hasActiveTab: Boolean(activeTab),
        hasRequest: this.getComposerCanonicalDraft().trim().length > 0,
        hasSession: Boolean(activeTab?.sessionId),
        permissionPending: activeTab ? this.hasPendingPermission(activeTab.id) : false,
        sendAvailable: this.controlAvailability().send === true,
        tabBusy: activeTab ? this.isTabBusy(activeTab.id) : false,
        tabLoading: activeTab ? this.isTabLoading(activeTab.id) : false,
      });
    } else if (
      !activeTab ||
      this.isStopping() ||
      !this.controlAvailability().send ||
      this.isTabBusy(activeTab.id) ||
      this.isTabLoading(activeTab.id) ||
      this.hasPendingPermission(activeTab.id)
    ) {
      return;
    }
    if (!activeTab) {
      return;
    }
    if (!activeTab.sessionId) {
      if (options.fromStopAndSend) {
        throw new Error("This conversation is still starting.");
      }
      new Notice("This conversation is still starting.");
      return;
    }
    const client = this.plugin.getClient(activeTab.id);
    if (client.sessionId !== activeTab.sessionId) {
      try {
        await this.ensureClientForTab(activeTab.id);
      } catch (error) {
        if (options.fromStopAndSend) {
          throw error instanceof Error ? error : new Error(this.messageFor(error));
        }
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
      if (options.fromStopAndSend) {
        throw new Error("Conversation session is no longer active for stop-and-send.");
      }
      return;
    }
    const rawRequest = this.getComposerCanonicalDraft().trim();
    // Two separate states: any slash invocation (menu token or free-typed
    // slash text) keeps the image/slash exclusivity, while a menu-selected
    // skill still routes like an ordinary model request (selection/document/
    // off context handling below). Native control commands stay bare.
    const { hasSlashInvocation, isSkill, isNativeSlashCommand } =
      composerInlineDraftRouting(this.composerDraft);
    const pendingImages = hasSlashInvocation
      ? []
      : this.pendingImages.get(activeTab.id) ?? [];
    if (pendingImages.length > 0 && !client.supportsImagePrompts) {
      if (options.fromStopAndSend) {
        throw new Error("The connected Hermes agent does not support image prompts.");
      }
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
      if (options.fromStopAndSend) {
        throw new Error("Stop-and-send snapshot is empty.");
      }
      return;
    }

    const selection = isNativeSlashCommand ? undefined : this.pendingSelection;
    // The current note's identity (path/title/body) is only ever read when the
    // context capsule is on; with the capsule off, this send path cannot obtain
    // the current note's path at all, so it cannot leak it to Hermes.
    const includeFullContext =
      !isNativeSlashCommand && !selection && this.includeCurrentDocumentContext;
    let documentContext: MarkdownDocumentContext | undefined;
    let activeNotePath: string | undefined;
    if (includeFullContext) {
      documentContext = this.plugin.getCurrentDocumentContext();
      if (documentContext) {
        this.setCurrentFile(documentContext.filePath);
      } else {
        activeNotePath = this.plugin.getCurrentMarkdownFilePath();
        this.setCurrentFile(activeNotePath);
      }
    }
    const notePath =
      !isNativeSlashCommand && !selection
        ? (documentContext?.filePath ?? activeNotePath)
        : undefined;
    const noteContextInjection: NoteContextInjectionKind | undefined =
      includeFullContext && notePath !== undefined
        ? resolveNoteContextInjection({
            previous: this.noteContextFingerprints.get(activeTab.id),
            currentPath: notePath,
            currentHash: documentContext?.documentHash,
          })
        : undefined;
    const prompt = buildOutboundPrompt({
      request,
      isSlashCommand: isNativeSlashCommand,
      isSkill,
      includeCurrentDocumentContext: this.includeCurrentDocumentContext,
      selection,
      documentContext,
      activeNotePath,
      noteContextInjection,
    });
    const runtime = this.turnRuntime(activeTab.id);
    // Only a full-document injection (or an explicit selection) narrows the
    // edit scope; changed/none injections carry no document body.
    this.editScopes.set(
      activeTab.id,
      selection ??
        ((noteContextInjection ?? "full") === "full" ? documentContext : undefined),
    );
    this.appendUserMessage(
      request,
      selection,
      noteContextInjection === "none" ? undefined : documentContext,
      activeTab.id,
      pendingImages,
      noteContextInjection === "changed"
        ? `${notePath} · note changed (not re-sent)`
        : undefined,
    );
    this.setComposerSlashToken(null);
    this.composerDraft = { token: null, text: "", references: [] };
    this.renderComposerInlineDraft();
    this.hideSlashMenu();
    if (!isNativeSlashCommand) {
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
    // Stop-and-send: snapshot is already on the outbound prompt and the user
    // message row. Restore continued typing NOW — before await sendPrompt —
    // so the composer stays available for the whole follow-up turn and later
    // keystrokes are not wiped when the turn settles. Also leave Stopping…
    // here: the snapshot is a normal new turn; holding waiting would disable
    // Stop/Esc for the entire follow-up agent turn.
    if (options.restoreComposerAfterDispatch !== undefined) {
      this.applyComposerCanonicalDraft(options.restoreComposerAfterDispatch);
    }
    options.onStopAndSendDispatched?.();
    this.updateControls(false);

    try {
      const outboundPrompt = buildEnvelopePrompt(prompt, isNativeSlashCommand);
      const promptContent: string | ContentBlock[] = pendingImages.length
        ? buildImagePrompt(outboundPrompt, pendingImages)
        : outboundPrompt;
      await client.sendPrompt(promptContent);
      // Fingerprints update only after a successful send: a native
      // /new|/reset|/compress resets the tab's dedupe state, otherwise the
      // sent note path+hash is recorded (full/changed) or left untouched
      // (none). Failed sends never write or update the fingerprint.
      if (isNativeSlashCommand && /^\/(new|reset|compress)(\s|$)/.test(request)) {
        this.noteContextFingerprints.delete(activeTab.id);
      } else if (
        notePath !== undefined &&
        noteContextInjection !== "none" &&
        noteContextInjection !== undefined
      ) {
        this.noteContextFingerprints.set(activeTab.id, {
          filePath: notePath,
          documentHash: documentContext?.documentHash ?? "",
        });
      }
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
      if (options.fromStopAndSend) {
        throw error instanceof Error ? error : new Error(this.messageFor(error));
      }
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

  private async handleComposerSubmit(): Promise<void> {
    if (this.isStopping()) {
      return;
    }
    const availability = this.controlAvailability();
    const facts = this.liveSteerableDraftFacts();
    const intent = composerSubmitIntent({
      stopAvailable: availability.stop === true,
      steerAvailable: availability.steer === true && !this.steerInFlight,
      facts,
      stopping: this.isStopping(),
      sendAvailable: availability.send === true,
    });
    switch (intent.kind) {
      case "send":
        await this.sendMessage();
        return;
      case "steer":
        await this.steerActiveTurnFromComposer();
        return;
      case "reject-rich":
        this.composerHint = intent.reason;
        this.updateControls(false);
        new Notice(intent.reason);
        return;
      case "noop":
        return;
    }
  }

  private async steerActiveTurnFromComposer(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (!activeTab || this.steerInFlight || !this.controlAvailability().steer) {
      return;
    }
    const text = this.composerDraft.text.trim();
    if (!text) {
      return;
    }
    const client = this.plugin.getClient(activeTab.id);
    this.steerInFlight = true;
    this.composerHint = undefined;
    this.updateControls(false);
    let result: SteerResult;
    try {
      result = await client.steerActiveTurn(text);
    } catch (error) {
      this.steerInFlight = false;
      this.composerHint = this.messageFor(error);
      this.updateControls(false);
      new Notice(`Hermesian steer failed: ${this.messageFor(error)}`);
      return;
    }
    this.steerInFlight = false;
    if (result.ok) {
      // Clear pure-text draft only after a verified steer success.
      this.composerDraft = {
        token: this.composerDraft.token,
        text: "",
        references: this.composerDraft.references,
      };
      this.renderComposerInlineDraft();
      this.captureActiveConversationRuntime();
      this.composerHint = undefined;
      this.updateControls(false);
      this.composerEl.focus();
      return;
    }
    this.composerHint = steerFailureMessage(result.reason);
    this.updateControls(false);
    new Notice(this.composerHint);
  }

  private async handleComposerStop(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    const availability = this.controlAvailability();
    const intent = composerStopIntent({
      stopAvailable: availability.stop === true,
      stopping: this.isStopping(),
      draft: this.getComposerCanonicalDraft(),
    });
    if (intent.kind === "noop") {
      return;
    }

    const client = this.plugin.getClient(activeTab.id);
    const runtime = this.turnRuntime(activeTab.id);

    if (intent.kind === "cancel") {
      try {
        await client.cancel();
      } catch (error) {
        new Notice(`Hermesian could not stop: ${this.messageFor(error)}`);
      }
      return;
    }

    // stop-and-send: snapshot the full send payload, clear composer for more
    // typing, show Stopping…, then wait on the main-turn completion barrier.
    this.ensureStopAndSendCoordinator();
    const snapshotDraft = intent.draft;
    const barrier = this.createStopAndSendBarrier(activeTab.id, runtime);

    this.stopAndSend!.beginStop(snapshotDraft, barrier);
    // If the barrier rejects (cancel never reached terminal), restore the
    // snapshot so the user does not lose the draft.
    void barrier.then(
      () => undefined,
      () => {
        const state = this.stopAndSend?.getState();
        if (state?.phase === "idle" && state.snapshot?.draft) {
          this.applyComposerCanonicalDraft(state.snapshot.draft);
          this.composerHint = state.lastError ?? "Stop failed before the turn ended.";
          this.updateControls(false);
          new Notice(`Hermesian: ${this.composerHint}`);
        }
      },
    );
    // Clear composer immediately so the user can keep typing the next idea.
    this.composerDraft = { token: null, text: "", references: [] };
    this.renderComposerInlineDraft();
    // Keep pending selection/images out of the cleared surface; the snapshotted
    // text is what stop-and-send will resend. Selection/images stay discarded
    // for the follow-up draft (user can re-attach).
    this.pendingSelection = undefined;
    this.renderSelectionBar();
    this.pendingImages.delete(activeTab.id);
    this.renderImageAttachmentBar();
    this.hideSlashMenu();
    this.composerHint = undefined;
    this.captureActiveConversationRuntime();
    this.updateControls(false);

    try {
      await client.cancel();
    } catch (error) {
      // cancel failure is reported via the barrier rejection path when the
      // turn never reaches terminal; surface a Notice for immediate feedback.
      new Notice(`Hermesian could not stop: ${this.messageFor(error)}`);
    }
  }

  /**
   * Barrier for stop-and-send: resolves only when TurnManager reports the
   * main turn idle via real complete()/waitUntilIdle subscription. No timers
   * and no microtask polling that would starve ACP cancel / turn-stop I/O.
   */
  private createStopAndSendBarrier(
    tabId: string,
    _runtime: { busy: boolean; completionPromise?: Promise<void> },
  ): Promise<void> {
    return this.turnManager.waitUntilIdle(tabId).then(() => {
      // Defensive: mirror onTurnComplete so follow-up send sees prompt idle
      // even if the original sendMessage finally has not run yet.
      this.controller?.setPromptRunning(tabId, false);
    });
  }

  private bindEscapeToStop(): void {
    if (this.escapeKeyBound) {
      return;
    }
    this.escapeKeyBound = true;
    this.registerDomEvent(this.containerEl.ownerDocument, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
        return;
      }
      // Only handle Esc when the Hermesian leaf owns the interaction surface.
      if (!this.containerEl.contains(event.target as Node) && this.app.workspace.getActiveViewOfType(HermesianSidebarView) !== this) {
        // Allow Esc from the message list / non-interactive chrome inside our leaf
        // even when focus is on the document body after clicking the transcript.
        if (!this.containerEl.contains(this.containerEl.ownerDocument.activeElement)) {
          return;
        }
      }
      const availability = this.controlAvailability();
      if (
        !shouldStopOnEscape({
          stopAvailable: availability.stop === true,
          stopping: this.isStopping(),
          focusOwnsEscape: focusOwnsEscape(event.target),
        })
      ) {
        return;
      }
      // Extra guard: never Stop while a local popover/menu is open.
      if (
        this.slashMenuItems.length > 0 ||
        this.modelPicker ||
        this.reasoningPicker ||
        this.permissions.size > 0
      ) {
        return;
      }
      event.preventDefault();
      void this.handleComposerStop();
    });
  }

  private async handleDictationToggle(): Promise<void> {
    if (this.dictationPhase === "transcribing") {
      return;
    }
    if (this.dictationPhase === "listening") {
      await this.stopDictationRecording();
      return;
    }
    if (!this.controlAvailability().composer) {
      return;
    }
    await this.startDictationRecording();
  }

  private async startDictationRecording(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.composerHint = "Microphone is not available in this environment.";
      this.updateControls(false);
      new Notice(this.composerHint);
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      this.composerHint = "MediaRecorder is not available in this environment.";
      this.updateControls(false);
      new Notice(this.composerHint);
      return;
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.composerHint =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission denied."
          : `Could not open microphone: ${this.messageFor(error)}`;
      this.updateControls(false);
      new Notice(this.composerHint);
      return;
    }

    const mimeType = preferredMediaRecorderMimeType();
    try {
      this.mediaRecorder = mimeType
        ? new MediaRecorder(this.mediaStream, { mimeType })
        : new MediaRecorder(this.mediaStream);
    } catch (error) {
      this.teardownDictationRecording();
      this.composerHint = `Could not start recording: ${this.messageFor(error)}`;
      this.updateControls(false);
      new Notice(this.composerHint);
      return;
    }

    this.mediaChunks = [];
    this.mediaRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.mediaChunks.push(event.data);
      }
    });
    this.mediaRecorder.addEventListener("error", () => {
      this.composerHint = "Recording failed.";
      this.teardownDictationRecording();
      this.dictationPhase = "idle";
      this.updateControls(false);
    });
    this.mediaRecorder.start();
    this.dictationPhase = "listening";
    this.composerHint = undefined;
    this.updateControls(false);
  }

  private async stopDictationRecording(): Promise<void> {
    const recorder = this.mediaRecorder;
    if (!recorder || this.dictationPhase !== "listening") {
      return;
    }
    const mimeType = recorder.mimeType || preferredMediaRecorderMimeType() || "audio/webm";
    const blob = await new Promise<Blob>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          resolve(new Blob(this.mediaChunks, { type: mimeType }));
        },
        { once: true },
      );
      try {
        recorder.stop();
      } catch {
        resolve(new Blob(this.mediaChunks, { type: mimeType }));
      }
    });
    this.teardownDictationRecording();

    if (dictationAudioTooShort(blob.size)) {
      this.dictationPhase = "idle";
      this.composerHint = "Recording was too short — nothing to transcribe.";
      this.updateControls(false);
      new Notice(this.composerHint);
      return;
    }

    this.dictationPhase = "transcribing";
    this.updateControls(false);

    let buffer: Uint8Array;
    try {
      buffer = new Uint8Array(await blob.arrayBuffer());
    } catch (error) {
      this.dictationPhase = "idle";
      this.composerHint = `Could not read recording: ${this.messageFor(error)}`;
      this.updateControls(false);
      new Notice(this.composerHint);
      return;
    }

    const result = await this.ensureDictationBridge().transcribe(buffer, mimeType);
    this.dictationPhase = "idle";
    if (!result.ok) {
      this.composerHint = dictationFailureMessage(result);
      this.updateControls(false);
      new Notice(this.composerHint);
      this.composerEl.focus();
      return;
    }
    if ("empty" in result && result.empty) {
      this.composerHint = "No speech detected.";
      this.updateControls(false);
      this.composerEl.focus();
      return;
    }
    const transcript = result.transcript.trim();
    if (!transcript) {
      this.composerHint = "No speech detected.";
      this.updateControls(false);
      this.composerEl.focus();
      return;
    }

    const inserted = insertTextAtCaret(
      this.composerEl,
      this.composerDraft,
      // Prefer a leading space when inserting mid-sentence.
      this.shouldPrefixDictationSpace() ? ` ${transcript}` : transcript,
      this.inlineRenderOptions(),
    );
    this.composerDraft = inserted.draft;
    this.composerHint = undefined;
    this.captureActiveConversationRuntime();
    this.updateControls(false);
    this.composerEl.focus();
  }

  private shouldPrefixDictationSpace(): boolean {
    const caret = getCaretOffset(this.composerEl);
    if (caret === null || caret <= 0) {
      return false;
    }
    const before = this.composerDraft.text.slice(caret - 1, caret);
    return before !== "" && before !== " " && before !== "\n";
  }

  private teardownDictationRecording(): void {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
    } catch {
      // ignore
    }
    this.mediaRecorder = undefined;
    this.mediaChunks = [];
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    this.mediaStream = undefined;
    if (this.dictationPhase === "listening") {
      this.dictationPhase = "idle";
    }
  }

  private updateControls(_busy: boolean, _showStop = _busy): void {
    const availability = this.controlAvailability();
    if (!availability.composer) {
      this.hideSlashMenu();
    }
    const stopping = this.isStopping();
    const primaryMode = composerPrimaryMode({
      stopping,
      stopAvailable: availability.stop === true,
      steerAvailable: availability.steer === true && !this.steerInFlight,
    });
    applyComposerState(
      {
        composerEl: this.composerEl,
        sendButtonEl: this.sendButtonEl,
        stopButtonEl: this.stopButtonEl,
        steerButtonEl: this.steerButtonEl,
        dictationButtonEl: this.dictationButtonEl,
        statusEl: this.composerStatusEl,
        hintEl: this.composerHintEl,
      },
      {
        disabled: !availability.composer,
        draft: this.composerDraft,
        placeholder: this.composerPlaceholder(),
        sendEnabled: availability.send && !stopping,
        stopVisible: primaryMode !== "send",
        primaryMode,
        stopEnabled: availability.stop === true && !stopping,
        steerEnabled: availability.steer === true && !this.steerInFlight && !stopping,
        dictationPhase: this.dictationPhase,
        dictationEnabled: availability.composer === true,
        hint: this.composerHint,
      },
    );
    this.renderAddConversationControl();
    this.historyButtonEl.disabled = !availability.history;
    this.reasoningButtonEl.disabled = !availability.reasoning;
    this.renderConversationTabs();
    this.renderSessionState(this.activeSessionState());
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
      this.noteContextFingerprints.delete(tabId);
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
    contextChip?: string,
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
        text: contextChip ?? `${documentContext.filePath} · full note context`,
        cls: "hermesian-message-context",
      });
    } else if (contextChip) {
      // changed-note marker with only an active-note path (no captured body)
      message.createDiv({
        text: contextChip,
        cls: "hermesian-message-context",
      });
    }
    // Display-layer safety net: any user text that is exactly an outbound
    // envelope product (resume/load history replay, future paths) renders as
    // the bare prompt. Idempotent for already-stripped or ordinary text.
    message.createDiv({
      text: stripEnvelopeFromPrompt(text),
      cls: "hermesian-message-content",
    });
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
    // Sending / replaying a user bubble means intent to follow the latest output.
    this.scrollToBottom(tabId, { force: true });
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
      normalizeTableSpacing(normalizeMathDelimiters(text)),
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

  private getComposerCanonicalDraft(): string {
    return serializeComposerInlineDraft(this.composerDraft);
  }

  private composerInlineDraftIsSlashCommand(): boolean {
    return composerInlineDraftIsSlashCommand(this.composerDraft);
  }

  /**
   * Value used for slash-menu matching.
   * With an active token the editor only holds the task, so rebuild the
   * canonical prefix for menu queries (empty task → "/skill name " form).
   */
  private getComposerSlashMenuValue(): string {
    if (!this.composerDraft.token) {
      return this.composerDraft.text;
    }
    return serializeComposerSlashDraft({
      token: this.composerDraft.token,
      task: this.composerDraft.text,
    });
  }

  private applyComposerCanonicalDraft(
    raw: string,
    explicitToken?: { kind: "skill" | "command"; name: string } | null,
    explicitReferences?: readonly (ReferenceToken | InlineReference)[] | null,
  ): void {
    // Single restore decision: restoreComposerInlineDraft validates the
    // token metadata, the reference metadata, AND draft consistency. New
    // schema placements must be exact; legacy prefix metadata migrates
    // losslessly. On any mismatch the raw draft stays verbatim as plain text.
    const restored = restoreComposerInlineDraft(raw, explicitToken, explicitReferences);
    this.setComposerSlashToken(restored.token);
    this.composerDraft = restored;
    this.renderComposerInlineDraft();
  }

  /**
   * Re-render the inline capsules inside the contenteditable editor.
   * Icons are injected by the host (Obsidian's setIcon).
   */
  private renderComposerInlineDraft(): void {
    renderInlineDraft(
      this.composerEl,
      this.composerDraft,
      this.inlineRenderOptions(),
    );
  }

  private inlineRenderOptions(): InlineEditorRenderOptions {
    return {
      onRemoveReference: (index) => {
        this.removeComposerReference(index);
      },
      renderIcon: (iconEl, kind) => {
        setIcon(iconEl, kind === "url" ? "link" : "file");
      },
    };
  }

  private removeComposerReference(index: number): void {
    this.composerDraft = {
      ...removeInlineReference(this.composerDraft, index),
      token: this.composerDraft.token,
    };
    this.renderComposerInlineDraft();
    this.captureActiveConversationRuntime();
    this.composerEl.focus();
  }

  private setComposerSlashToken(token: ComposerSlashToken | null): void {
    // Single source of truth: update the model FIRST, then project UI.
    this.composerDraft = { ...this.composerDraft, token };
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
    if (this.composerDraft.token) {
      return activeTabId && this.isTabLoading(activeTabId)
        ? "Add a task for this command…"
        : "Add a task…  ↵ to send · Shift+↵ for new line";
    }
    return activeTabId && this.isTabLoading(activeTabId)
      ? "Draft here — this conversation is starting"
      : "Ask Hermes…  ↵ to send · Shift+↵ for new line";
  }

  private updateComposerPlaceholder(): void {
    this.composerEl.setAttribute("data-placeholder", this.composerPlaceholder());
  }

  private scrollToBottom(
    sourceTabId?: string,
    options: { force?: boolean } = {},
  ): void {
    this.messageRenderer.scrollToBottom(sourceTabId, options);
  }

  private messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function requestHasRawContent(contents: ToolCallContent[]): boolean {
  return contents.length > 0;
}
