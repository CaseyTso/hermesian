import { PendingSendStore } from "./pending-send";
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
  type ConversationHistory,
} from "./conversation-controller";
import { conversationShortcutForEvent } from "./conversation-shortcuts";
import {
  cycleConversationTabId,
  isActiveConversationSession,
  resolveConversationTabTitle,
  updateConversationTab,
  type PersistedConversationTab,
  type PersistedConversationWorkspace,
} from "./conversation-tabs";
import {
  type ConversationAggregateControlAvailability,
  type ConversationControlAvailability,
  type SteerableDraftFacts,
} from "./conversation-runtime";
import {
  createDebugLogger,
  safeErrorFields,
  type DebugLogger,
} from "./debug-logger";
import { linkifyExternalUrls } from "./external-links";
import { HERMESIAN_ICON_ID } from "./hermes-icon";
import {
  buildImagePrompt,
  imageAttachmentFromDataUrl,
  isImageClipboardItem,
  MAX_PASTED_IMAGE_BYTES,
  type PastedImageAttachment,
} from "./image-attachments";
import {
  extractGuardedCode,
  restoreGuardedCode,
  type GuardedCodeFragment,
} from "./markdown-code-guard";
import {
  extractMermaidBlocks,
  replaceMermaidPlaceholders,
} from "./markdown-mermaid";
import { normalizeMathDelimiters } from "./markdown-math";
import { normalizeTableSpacing } from "./markdown-table";
import {
  contextUsageLevel,
  contextUsagePercent,
  formatContextUsage,
  normalizeTitleGenerationModel,
} from "./session-state";
import {
  buildDocumentCaption,
  buildOutboundPrompt,
  buildSelectionCaption,
  noteTitle,
} from "./selection-context";
import { isReasoningEffort, reasoningEffortLabel } from "./session-history";
import { loadHermesModelCatalog } from "./hermes-model-catalog";
import { HermesHistorySuggestModal } from "./ui/conversation-modals";
import {
  TableModal,
  handleRenderedLinkClick,
} from "./ui/table-modal";
import {
  generateHermesSessionTitle,
  renameHermesSession,
} from "./hermes-session-title";
import { HermesModelPickerPopover } from "./ui/model-picker-popover";
import { HermesReasoningPickerPopover } from "./ui/reasoning-picker-popover";
import { HermesTitlePopover } from "./ui/title-popover";
import { HermesContextGaugePopover } from "./ui/context-gauge-popover";
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
  shouldRecordSteer,
  type TurnCallbacks,
} from "./ui/message-renderer";
import { ScrollFollowController } from "./ui/scroll-lock";
import { TurnRail } from "./ui/turn-rail";
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
  derivePickedFolderPath,
  insertInlineReference,
  removeInlineReference,
  resolvePickedFilePath,
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
import {
  buildEnvelopePrompt,
  stripUserPromptForDisplay,
} from "./outbound-envelope";
import {
  composerPrimaryMode,
  composerStopIntent,
  composerSubmitIntent,
  dictationAudioTooShort,
  focusOwnsEscape,
  formatSteerPendingPreview,
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

/**
 * Lazy Electron `webUtils.getPathForFile` resolver. Electron >= 32 removes
 * the legacy `File.path` (deprecated since 29); `webUtils` is the official
 * replacement. `require("electron")` must stay lazy and guarded: mobile/
 * browser builds have no electron module, and an eager import would crash
 * plugin load there. Returns null when electron/webUtils is unavailable.
 */
function electronWebUtilsResolver(file: File): string | null {
  try {
    // Structural cast only — electron typings are not installed and must not
    // be (electron is an esbuild external); runtime semantics are identical
    // to `require("electron") as typeof import("electron")`.
    const electron = require("electron") as
      | { webUtils?: { getPathForFile?: (file: File) => string } }
      | undefined;
    const resolved = electron?.webUtils?.getPathForFile?.(file);
    return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

interface PendingComposerSend {
  tabId: string;
  draft: ComposerInlineDraft;
  images: PastedImageAttachment[];
  selection?: SelectionContext;
  includeCurrentDocumentContext: boolean;
  activeNotePath?: string;
  activeNoteAbsolutePath?: string;
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
  private lastControllerWorkspace: PersistedConversationWorkspace | undefined;
  private controller: ConversationController<HermesAcpClient> | undefined;
  private readonly pendingSends = new PendingSendStore<PendingComposerSend>();
  private viewEpoch = 0;
  private viewClosed = false;
  private readonly displayedHistories = new Map<string, ConversationHistory>();
  private readonly historyRendering = new Map<string, Promise<void>>();
  private controllerUnsubscribe: (() => void) | undefined;
  private contextGaugeEl!: HTMLElement;
  private contextGaugeFillEl!: SVGCircleElement;
  private currentFileBarEl!: HTMLButtonElement;
  private currentFileLabelEl!: HTMLElement;
  private currentFilePath: string | undefined;
  private includeCurrentDocumentContext = true;
  private historyButtonEl!: HTMLButtonElement;
  private imageAttachmentBarEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  /** `createSidebarShell` root: the `.hermesian-view` element itself. */
  private sidebarRootEl!: HTMLElement;
  private modelButtonEl!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private modelPicker: HermesModelPickerPopover | null = null;
  private pendingSelection: SelectionContext | undefined;
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly loadedMessageTabIds = new Set<string>();
  private messageRenderer!: MessageRenderer;
  private scrollFollow!: ScrollFollowController;
  private turnRail!: TurnRail;
  private turnManager!: TurnManager;
  private readonly editScopes = new Map<
    string,
    SelectionContext | { filePath: string } | undefined
  >();
  private readonly pendingImages = new Map<string, PastedImageAttachment[]>();
  private reasoningButtonEl!: HTMLButtonElement;
  private reasoningLabelEl!: HTMLElement;
  private reasoningPicker: HermesReasoningPickerPopover | null = null;
  private titlePopover: HermesTitlePopover | null = null;
  private titlePopoverAnchorEl: HTMLElement | undefined;
  private cachedTitleCatalogModels: HermesModelOption[] = [];
  private titleCatalogLoading = false;
  private contextGaugePopover: HermesContextGaugePopover | null = null;
  private readonly tabFirstUserMessages = new Map<string, string>();
  private readonly transientSystemMessages = new Map<string, HTMLElement>();
  private readonly pendingUsageFinalizes = new Set<string>();
  private selectionBarEl!: HTMLElement;
  private sendButtonEl!: HTMLButtonElement;
  private steerButtonEl!: HTMLButtonElement;
  private steerModeEl!: HTMLElement;
  private dictationButtonEl!: HTMLButtonElement;
  private filePickerButtonEl!: HTMLButtonElement;
  private fileInputEl!: HTMLInputElement;
  private folderInputEl!: HTMLInputElement;
  private filePickerMenuEl!: HTMLElement;
  /** Caret captured when the file/folder dialog opens (P1-2). */
  private pendingFilePickerCaret: number | null = null;
  /** Detaches document-level listeners added by the composer view. */
  private composerDispose: (() => void) | undefined;
  private composerHintEl!: HTMLElement;
  private composerStatusEl!: HTMLElement;
  private slashMenuEl!: HTMLElement;
  private slashTokenEl!: HTMLElement;
  private slashTokenIconEl!: HTMLElement;
  private slashTokenLabelEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private readonly tabSelections = new Map<string, SelectionContext | undefined>();
  private slashMenuIndex = 0;
  private slashMenuItems: SlashMenuItem[] = [];
  private statusEl!: HTMLElement;
  private headerTitleEl!: HTMLElement;
  private startup: ViewStartupCoordinator | undefined;
  private startupStatusClickBound = false;
  /** Ephemeral composer hint (steer reject, STT error). Cleared on next draft change. */
  private composerHint: string | undefined;
  /** True while a pure-text steer request is outstanding (disables Steer). */
  private steerInFlight = false;
  /** Last gateway reply-grouping id per tab; a change starts a new bubble. */
  private lastAssistantMessageId = new Map<string, string>();
  steerPendingRowEl: HTMLElement | undefined;
  steerPendingChipEl: HTMLElement | undefined;
  steerPendingIconEl: HTMLElement | undefined;
  steerPendingTextEl: HTMLElement | undefined;
  steerPendingStatusEl: HTMLElement | undefined;
  private dictationPhase: DictationUiPhase = "idle";
  private mediaRecorder: MediaRecorder | undefined;
  private mediaStream: MediaStream | undefined;
  private mediaChunks: BlobPart[] = [];
  private dictationBridge: DictationBridge | undefined;
  private stopAndSend: StopAndSendCoordinator | undefined;
  private escapeKeyBound = false;
  private conversationShortcutsBound = false;
  private readonly logger: DebugLogger;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HermesianPlugin,
  ) {
    super(leaf);
    this.logger = createDebugLogger(Boolean(plugin?.settings?.debugLogging));
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
    this.viewClosed = false;
    this.viewEpoch += 1;
    this.startupStatusClickBound = false;
    this.renderShell();
    this.updateControls(true, false);
    this.plugin.attachView(this);
    this.bindStartupStatusRetry();
    this.bindEscapeToStop();
    this.bindConversationShortcuts();
    this.ensureConversationController();
    this.restoreActiveConversationRuntime();
    if (this.conversationWorkspace) {
      this.showConversationMessages(this.conversationWorkspace.activeTabId);
      void this.controller?.readWorkspaceHistory();
    }
    this.renderConversationTabs();
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
      onStatus: () => { this.renderReadinessStatus(); },
    });
    // Must return immediately so Obsidian layout restore is never blocked on ACP.
    this.startup.begin();
  }

  async onClose(): Promise<void> {
    this.viewClosed = true;
    this.pendingSends.clear();
    this.viewEpoch += 1;
    this.displayedHistories.clear();
    this.historyRendering.clear();
    this.loadedMessageTabIds.clear();
    this.composerDispose?.();
    this.composerDispose = undefined;
    this.messageRenderer?.destroy();
    this.turnRail?.destroy();
    this.modelPicker?.detach();
    this.modelPicker = null;
    this.reasoningPicker?.detach();
    this.reasoningPicker = null;
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.titlePopoverAnchorEl = undefined;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
    this.startup?.close();
    this.startup = undefined;
    this.hideSteerPendingChip();
    this.teardownDictationRecording();
    this.captureActiveConversationRuntime();
    const controller = this.controller;
    for (const [permissionId, permission] of this.permissions) {
      controller?.completePermission(permissionId);
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    this.controllerUnsubscribe?.();
    this.controllerUnsubscribe = undefined;
    this.controller = undefined;
    // Invalidate ownership and detach registry slots synchronously, before any
    // persistence/disconnect await. A reopened view must get fresh clients.
    const shutdown = controller?.shutdown();
    const release = this.plugin.releaseView(this);
    try {
      await this.plugin.flushConversationWorkspace(this.conversationWorkspace);
    } finally {
      await Promise.allSettled([shutdown, release]);
    }
  }

  setSelection(context: SelectionContext): void {
    if (this.hasPendingSend()) return;
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
        this.appendAssistantDelta(tabId, event.text, event.messageId);
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
      case "turn-split":
        void this.handleTurnSplit(tabId, event.text);
        return;
      case "usage":
        this.scheduleUsageFinalize(tabId);
        return;
      case "session-title":
        void this.controller?.setConversationTitle(tabId, event.title).catch(() => {});
        return;
    }
  }

  handleHermesSessionState(tabId: string, state: HermesSessionState): void {
    this.controller?.updateClientState(tabId, state);
    if (!this.conversationWorkspace || this.conversationWorkspace.activeTabId === tabId) {
      this.renderSessionState(state);
    }
    if (state.contextUsage) {
      this.scheduleUsageFinalize(tabId);
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
    this.headerTitleEl = shell.headerTitleEl;
    this.addConversationButtonEl = shell.addConversationButtonEl;
    this.historyButtonEl = shell.historyButtonEl;
    this.contextGaugeEl = shell.contextGaugeEl;
    this.contextGaugeFillEl = shell.contextGaugeFillEl;
    this.conversationTabsEl = shell.conversationTabsEl;
    this.messagesEl = shell.messagesEl;
    this.sidebarRootEl = shell.root;
    this.scrollFollow = new ScrollFollowController();
    this.messageRenderer = new MessageRenderer(this.messagesEl, {
      scrollFollow: this.scrollFollow,
    });
    this.turnRail = new TurnRail({
      messagesEl: this.messagesEl,
      hostEl: shell.messagesContainerEl ?? this.messagesEl.parentElement ?? this.messagesEl,
      scrollFollow: this.scrollFollow,
      onScrollToBottom: (tabId) => {
        this.scrollToBottom(tabId, { force: true });
      },
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
        this.turnRail?.setActiveTurn(tabId, false);
      },
      onAssistantMessageCreated: (messageEl: HTMLElement) => {
        this.attachMessageCopyButton(messageEl);
      },
    };
    this.turnManager = new TurnManager(this.messageRenderer, turnCallbacks);

    // Wire icons (needs Obsidian's setIcon)
    setIcon(shell.root.querySelector(".hermesian-logo")!, HERMESIAN_ICON_ID);
    setIcon(shell.addConversationButtonEl, "square-plus");
    setIcon(shell.historyButtonEl, "history");

    this.contextGaugeEl.addEventListener("click", () => {
      this.toggleContextGaugePopover();
    });

    this.headerTitleEl.addEventListener("click", () => {
      this.openActiveTabTitlePopover();
    });
    this.headerTitleEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.headerTitleEl.click();
      }
    });

    this.setTransientSystemMessage(
      "Select text in a Markdown note and run 'Ask Hermes about selection' to focus a question or edit on that passage.",
    );

    const composerCallbacks: ComposerCallbacks = {
      getDraft: () => this.composerDraft,
      onDraftChange: (draft: ComposerInlineDraft) => {
        if (this.hasPendingSend()) return;
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
      onFilePickerOpen: () => {
        this.pendingFilePickerCaret = getCaretOffset(this.composerEl);
      },
      onKeydown: (event: KeyboardEvent) => {
        this.handleComposerKeydown(event);
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
        if (this.hasPendingSend()) { event.preventDefault(); return; }
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
      placeholder: "",
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
    this.steerModeEl = composerElements.steerModeEl;
    this.steerPendingRowEl = composerElements.steerPendingRowEl;
    this.steerPendingChipEl = composerElements.steerPendingChipEl;
    this.steerPendingIconEl = composerElements.steerPendingIconEl;
    this.steerPendingTextEl = composerElements.steerPendingTextEl;
    this.steerPendingStatusEl = composerElements.steerPendingStatusEl;
    this.stopButtonEl = composerElements.stopButtonEl;
    this.dictationButtonEl = composerElements.dictationButtonEl;
    this.filePickerButtonEl = composerElements.filePickerButtonEl;
    this.fileInputEl = composerElements.fileInputEl;
    this.folderInputEl = composerElements.folderInputEl;
    this.filePickerMenuEl = composerElements.filePickerMenuEl;
    this.composerDispose = composerElements.dispose;
    this.composerHintEl = composerElements.hintEl;
    this.composerStatusEl = composerElements.statusEl;

    // Wire icons (needs Obsidian's setIcon)
    setIcon(composerElements.currentFileBarEl.querySelector(".hermesian-current-file-icon")!, "file-text");
    setIcon(composerElements.modelButtonEl.querySelector(".hermesian-model-icon")!, "bot");
    setIcon(composerElements.modelButtonEl.querySelector(".hermesian-model-chevron")!, "chevron-down");
    setIcon(composerElements.reasoningButtonEl.querySelector(".hermesian-reasoning-icon")!, "brain");
    setIcon(composerElements.addSelectionButtonEl.querySelector("span")!, "text-select");
    setIcon(composerElements.filePickerButtonEl.querySelector("span")!, "paperclip");
    setIcon(composerElements.dictationButtonEl.querySelector("span")!, "mic");
    setIcon(composerElements.sendButtonEl.querySelector("span")!, "arrow-right");
    setIcon(composerElements.steerButtonEl.querySelector("span")!, "corner-down-left");
    setIcon(composerElements.stopButtonEl.querySelector("span")!, "square");
    setIcon(composerElements.steerModeEl.querySelector(".hermesian-steer-mode-icon")!, "corner-down-left");
    if (composerElements.steerPendingIconEl) {
      setIcon(composerElements.steerPendingIconEl, "corner-down-left");
    }
    this.setComposerSlashToken(null);
    this.renderComposerInlineDraft();

    // Wire event handlers
    this.currentFileBarEl.addEventListener("click", () => {
      if (!this.currentFilePath || this.hasPendingSend()) {
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

    this.fileInputEl.addEventListener("change", () => {
      this.insertPickedFileReference(this.fileInputEl, false);
    });
    this.folderInputEl.addEventListener("change", () => {
      this.insertPickedFileReference(this.folderInputEl, true);
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
    await this.controller.initialize();
  }

  private handleStartupFailure(_error: unknown): void {
    if (this.viewClosed) return;
    this.renderReadinessStatus();
    this.updateControls(false);
  }

  private renderReadinessStatus(): void {
    if (this.viewClosed) return;
    const id = this.conversationWorkspace?.activeTabId;
    const connection = id ? this.controller?.getSnapshot().tabOperations.get(id)?.connection : undefined;
    this.applyStartupStatus(connection === "failed" ? "error" : connection === "ready" ? "ready" : "connecting");
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
      if (this.statusEl.dataset.status !== "connected") {
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
      const tabId = this.conversationWorkspace?.activeTabId;
      if (tabId && this.controller?.getSnapshot().tabOperations.get(tabId)?.connection === "failed") {
        this.startConversationHydration(tabId);
      }
    });
  }

  private handleControllerSnapshot(
    snapshot: ConversationControllerSnapshot,
  ): void {
    if (this.viewClosed) return;
    // Status/history publications reuse the same workspace object. They must
    // not roll back composer edits captured since the last structural commit.
    if (snapshot.workspace && snapshot.workspace !== this.lastControllerWorkspace) {
      this.lastControllerWorkspace = snapshot.workspace;
      this.conversationWorkspace = snapshot.workspace;
      if (this.headerTitleEl) {
        this.updateHeaderTitle();
      }
    }
    for (const [tabId, history] of snapshot.histories) {
      if (this.displayedHistories.get(tabId) === history) continue;
      this.displayedHistories.set(tabId, history);
      const epoch = this.viewEpoch;
      const current = () => !this.viewClosed && this.viewEpoch === epoch &&
        this.displayedHistories.get(tabId) === history &&
        this.conversationWorkspace?.tabs.some((tab) => tab.id === tabId && tab.sessionId === history.sessionId) === true;
      const rendering = (this.historyRendering.get(tabId) ?? Promise.resolve()).then(async () => {
        if (!current() || this.isTabBusy(tabId)) return;
        await this.renderHistorySession({ cwd: "", sessionId: history.sessionId }, history.items, false, tabId, current);
      }).catch(() => { /* Local display failure must not block runtime readiness. */ });
      this.historyRendering.set(tabId, rendering);
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
    this.turnRail?.switchTab(tabId);
  }

  private forgetConversationMessages(tabId: string): void {
    this.tabFirstUserMessages?.delete(tabId);
    this.transientSystemMessages?.delete(tabId);
    this.loadedMessageTabIds.delete(tabId);
    this.displayedHistories.delete(tabId);
    this.historyRendering.delete(tabId);
    this.messageRenderer.forget(tabId);
    this.turnRail?.forget(tabId);
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
      this.titlePopover?.detach();
      this.titlePopover = null;
      this.contextGaugePopover?.detach();
      this.contextGaugePopover = null;
      this.conversationTabsEl.empty();
      return;
    }
    const callbacks: ConversationTabsCallbacks = {
      onActivate: (tabId) => { void this.switchConversation(tabId); },
      onClose: (tabId) => { void this.closeConversation(tabId); },
      onContextMenu: (tabId, anchorEl) => {
        this.openTitlePopover(tabId, anchorEl);
      },
    };
    renderConversationTabsView(this.conversationTabsEl, {
      activeTabId: workspace.activeTabId,
      isTabBusy: (tabId) => this.isTabBusy(tabId),
      isTabLoading: (tabId) => this.isTabLoading(tabId),
      isTabFailed: (tabId) => this.controller?.getSnapshot().tabOperations.get(tabId)?.connection === "failed",
      tabNavigationDisabled: !this.controlAvailability().tabNavigation,
      tabs: workspace.tabs,
      resolveTabTitle: (tab) => resolveConversationTabTitle(tab, this.firstUserMessageForTab(tab.id)),
    }, callbacks);

    if (this.titlePopover?.isOpen()) {
      const popoverTabId = this.titlePopover.getTabId();
      const activePopoverTab = workspace.tabs.find((t) => t.id === popoverTabId);
      const anchorEl = this.titlePopoverAnchorEl?.isConnected
        ? this.titlePopoverAnchorEl
        : this.conversationTabsEl.querySelector<HTMLElement>(
            `[data-conversation-tab-id="${popoverTabId}"]`,
          );
      if (!anchorEl || !activePopoverTab) {
        this.titlePopover.detach();
        this.titlePopover = null;
        this.titlePopoverAnchorEl = undefined;
      } else {
        this.titlePopover.updateAnchor(anchorEl);
        const title = resolveConversationTabTitle(
          activePopoverTab,
          this.firstUserMessageForTab(activePopoverTab.id),
        );
        this.titlePopover.updateExternalTitle(title, {
          hasCustomTitle: Boolean(activePopoverTab.title?.trim()),
          canGenerateAi: Boolean(activePopoverTab.sessionId) && this.tabHasMessages(activePopoverTab.id),
        });
      }
    }

    this.updateHeaderTitle();
  }

  /** Mirrors the active conversation title into the header title element. */
  private updateHeaderTitle(): void {
    if (!this.headerTitleEl) {
      return;
    }
    const activeTab = this.activeConversationTab();
    const resolved = activeTab
      ? resolveConversationTabTitle(activeTab, this.firstUserMessageForTab(activeTab.id))
      : "未命名会话";
    this.headerTitleEl.textContent = resolved;
    this.headerTitleEl.title = resolved;
  }

  /** Opens the title popover for the active conversation, anchored to the header title. */
  private openActiveTabTitlePopover(): void {
    const workspace = this.conversationWorkspace;
    if (!workspace) {
      return;
    }
    this.openTitlePopover(workspace.activeTabId, this.headerTitleEl);
  }

  private openTitlePopover(tabId: string, anchorEl: HTMLElement): void {
    if (this.titlePopover?.isOpen() && this.titlePopover.getTabId() === tabId) {
      this.titlePopover.detach();
      this.titlePopover = null;
      this.titlePopoverAnchorEl = undefined;
      return;
    }
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.titlePopoverAnchorEl = undefined;
    this.modelPicker?.detach();
    this.modelPicker = null;
    this.reasoningPicker?.detach();
    this.reasoningPicker = null;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;

    const tab = this.conversationWorkspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || this.isTabClosing(tabId)) {
      return;
    }

    const currentTitle = resolveConversationTabTitle(tab, this.firstUserMessageForTab(tabId));
    const hasCustomTitle = Boolean(tab.title?.trim());
    const canGenerateAi = Boolean(tab.sessionId) && this.tabHasMessages(tabId);
    const availableModels = this.getAvailableTitleModels(tabId);
    const sessionCatalogLoading =
      this.controller?.getSnapshot().sessionStates.get(tabId)?.catalogLoading ?? false;

    this.titlePopoverAnchorEl = anchorEl;
    this.titlePopover = new HermesTitlePopover({
      anchorEl,
      tabId,
      tabLabel: tab.label,
      currentTitle,
      hasCustomTitle,
      canGenerateAi,
      models: availableModels,
      catalogLoading: sessionCatalogLoading || this.titleCatalogLoading,
      hiddenModelSwitchIds: this.plugin.settings.hiddenModelSwitchIds,
      providerExpansion: this.plugin.settings.modelProviderExpansion,
      selectedAiModel: this.getTitleAiModelPreference(),
      selectedAiReasoningEffort: this.getTitleAiReasoningPreference(),
      getContainerRect: () => {
        const rect = this.sidebarRootEl.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      },
      iconRenderer: (element, icon) => setIcon(element, icon),
      onSelectAiModel: async (model) => await this.saveTitleAiModelPreference(model),
      onSelectAiReasoning: async (effort) => await this.saveTitleAiReasoningPreference(effort),
      onSaveProviderExpansion: (expansion) =>
        this.plugin.saveModelProviderExpansion?.(expansion),
      onRename: async (nextTitle) => await this.renameConversationTitle(tabId, nextTitle),
      onGenerateAi: async () => await this.generateAiConversationTitle(tabId),
      onClose: () => {
        this.titlePopover = null;
        this.titlePopoverAnchorEl = undefined;
      },
    });
    this.titlePopover.open();

    if (
      availableModels.length === 0 &&
      !this.titleCatalogLoading &&
      typeof this.plugin.settings?.hermesExecutable === "string" &&
      this.plugin.settings.hermesExecutable.trim()
    ) {
      void this.loadFallbackTitleModels();
    }
  }

  private getTitleAiModelPreference(): HermesModelOption | undefined {
    return normalizeTitleGenerationModel(this.plugin.settings?.titleGenerationModel);
  }

  private getTitleAiReasoningPreference(): ReasoningEffort {
    const raw = this.plugin.settings?.titleGenerationReasoningEffort;
    return typeof raw === "string" && isReasoningEffort(raw) ? raw : "none";
  }

  private async saveTitleAiModelPreference(
    model: HermesModelOption | undefined,
  ): Promise<void> {
    const normalized = normalizeTitleGenerationModel(model);
    const effort = this.getTitleAiReasoningPreference();
    if (typeof this.plugin.saveTitleGenerationPreferences === "function") {
      await this.plugin.saveTitleGenerationPreferences({
        model: normalized,
        reasoningEffort: effort,
      });
      return;
    }
    this.plugin.settings.titleGenerationModel = normalized;
    await this.plugin.savePluginSettings?.();
  }

  private async saveTitleAiReasoningPreference(
    effort: ReasoningEffort,
  ): Promise<void> {
    const model = this.getTitleAiModelPreference();
    if (typeof this.plugin.saveTitleGenerationPreferences === "function") {
      await this.plugin.saveTitleGenerationPreferences({
        model,
        reasoningEffort: effort,
      });
      return;
    }
    this.plugin.settings.titleGenerationReasoningEffort = effort;
    await this.plugin.savePluginSettings?.();
  }

  private getAvailableTitleModels(tabId: string): HermesModelOption[] {
    const snapshot = this.controller?.getSnapshot();
    const tabModels = snapshot?.sessionStates.get(tabId)?.models;
    if (tabModels && tabModels.length > 0) {
      return tabModels;
    }
    if (snapshot) {
      for (const sessionState of snapshot.sessionStates.values()) {
        if (sessionState.models.length > 0) {
          return sessionState.models;
        }
      }
    }
    return this.cachedTitleCatalogModels;
  }

  private async loadFallbackTitleModels(): Promise<void> {
    if (this.titleCatalogLoading) {
      return;
    }
    this.titleCatalogLoading = true;
    this.titlePopover?.updateAiOptions({ catalogLoading: true });
    try {
      const catalog = await loadHermesModelCatalog(
        resolveHermesExecutable(this.plugin.settings.hermesExecutable),
        this.plugin.settings.profile,
      );
      const models: HermesModelOption[] = [];
      for (const provider of catalog.providers) {
        for (const model of provider.models) {
          models.push(model);
        }
      }
      this.cachedTitleCatalogModels = models;
      if (this.titlePopover?.isOpen()) {
        const popoverTabId = this.titlePopover.getTabId();
        const latest = this.getAvailableTitleModels(popoverTabId);
        this.titlePopover.updateAiOptions({
          models: latest,
          catalogLoading: false,
        });
      }
    } catch {
      if (this.titlePopover?.isOpen()) {
        this.titlePopover.updateAiOptions({ catalogLoading: false });
      }
    } finally {
      this.titleCatalogLoading = false;
    }
  }

  private async renameConversationTitle(
    tabId: string,
    nextTitle: string,
  ): Promise<string> {
    const tab = this.conversationWorkspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new Error("会话不可用");
    }
    const sessionId = tab.sessionId
      ? tab.sessionId
      : (await this.ensureTabSession(tabId)).sessionId;
    const saved = await renameHermesSession(
      resolveHermesExecutable(this.plugin.settings.hermesExecutable),
      this.plugin.settings.profile,
      sessionId,
      nextTitle,
    );
    await this.controller?.setConversationTitle(tabId, saved, sessionId);
    this.renderConversationTabs();
    return saved;
  }

  private async generateAiConversationTitle(tabId: string): Promise<string> {
    const tab = this.conversationWorkspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab?.sessionId) {
      throw new Error("发送消息后可用");
    }
    const saved = await generateHermesSessionTitle(
      resolveHermesExecutable(this.plugin.settings.hermesExecutable),
      this.plugin.settings.profile,
      tab.sessionId,
      this.userMessagesForTab(tabId),
      {
        model: this.getTitleAiModelPreference(),
        reasoningEffort: this.getTitleAiReasoningPreference(),
      },
    );
    await this.controller?.setConversationTitle(tabId, saved, tab.sessionId);
    this.renderConversationTabs();
    return saved;
  }

  private async ensureTabSession(tabId: string): Promise<{ sessionId: string }> {
    return await this.ensureClientForTab(tabId);
  }

  private firstUserMessageForTab(tabId: string): string | undefined {
    const historyItems =
      this.displayedHistories.get(tabId)?.items ??
      this.controller?.getSnapshot().histories.get(tabId)?.items;
    if (historyItems) {
      for (const item of historyItems) {
        if (item.kind === "user" && item.text?.trim()) {
          return item.text.trim();
        }
      }
    }
    return this.tabFirstUserMessages?.get(tabId);
  }

  private userMessagesForTab(tabId: string): string[] {
    const historyItems =
      this.displayedHistories.get(tabId)?.items ??
      this.controller?.getSnapshot().histories.get(tabId)?.items ??
      [];
    const userTexts: string[] = [];
    for (const item of historyItems) {
      if (item.kind === "user" && item.text?.trim()) {
        userTexts.push(item.text.trim());
      }
    }
    if (userTexts.length > 0) {
      return userTexts;
    }
    try {
      const container = this.messageContainer(tabId);
      const nodes = container.querySelectorAll(
        ".hermesian-message.is-user .hermesian-message-body, .hermesian-message.is-user .hermesian-message-content",
      );
      for (const node of Array.from(nodes)) {
        const text = node.textContent?.trim();
        if (text) {
          userTexts.push(text);
        }
      }
    } catch {
      // DOM query fallback
    }
    if (userTexts.length > 0) {
      return userTexts;
    }
    const fallback = this.tabFirstUserMessages?.get(tabId);
    return fallback ? [fallback] : [];
  }

  private tabHasMessages(tabId: string): boolean {
    return (
      this.userMessagesForTab(tabId).length > 0 ||
      this.firstUserMessageForTab(tabId) !== undefined
    );
  }

  private async addConversation(): Promise<void> {
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
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
      this.setTransientSystemMessage(
        "Starting a new Hermes conversation…",
        pendingTabId,
        { loading: true },
      );
    }

    try {
      const result = await adding;
      this.conversationWorkspace = result.workspace;
      this.loadedMessageTabIds.add(result.tabId);
      if (result.workspace.activeTabId === result.tabId) {
        this.showConversationMessages(result.tabId);
      }
      this.renderConversationTabs();
      this.setTransientSystemMessage(
        "New Hermes conversation started.",
        result.tabId,
      );
    } catch (_error) {
      if (pendingTabId) {
        this.clearTransientSystemMessage(pendingTabId);
      }
      this.renderReadinessStatus();
    }
  }

  private async closeConversation(tabId: string): Promise<void> {
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
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
      this.pendingSends.cancel(tabId);
      this.tabSelections.delete(tabId);
      this.pendingImages.delete(tabId);
      this.forgetConversationMessages(tabId);
      this.turnManager.delete(tabId);

      const activeTabId = result.workspace.activeTabId;
      this.showConversationMessages(activeTabId);
      // Start owner-scoped hydration for the replacement when needed
      if (result.replacementTabId) {
        this.showConversationMessages(result.replacementTabId);
        this.setTransientSystemMessage(
          "Conversation closed. A new Hermes conversation started.",
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
    const controller = this.controller;
    if (!controller) return;
    void controller.ensureConversationReady(tabId).catch(() => {
      if (!this.viewClosed && this.controller === controller) this.renderReadinessStatus();
    });
  }

  private async switchConversation(tabId: string): Promise<void> {
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
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
        this.setTransientSystemMessage(
          "New Hermes conversation started.",
          result.tabId,
        );
      }
      this.showConversationMessages(result.tabId);
      this.restoreActiveConversationRuntime();
      this.renderSessionState(
        this.controller?.getSnapshot().sessionStates.get(result.tabId) ?? this.activeSessionState(),
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
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.reasoningPicker?.detach();
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
    const targetTabId = activeTab.id;
    let settled = false;
    this.modelPicker = new HermesModelPickerPopover({
      anchorEl: this.modelButtonEl,
      models: state.models,
      hiddenSwitchIds: this.plugin.settings.hiddenModelSwitchIds,
      providerExpansion: this.plugin.settings.modelProviderExpansion,
      currentSwitchId: state.currentModel?.switchId,
      iconRenderer: (element, icon) => setIcon(element, icon),
      // The popover width follows the sidebar content box, not the trigger
      // button. `this.sidebarRootEl` is the element `createSidebarShell` returns
      // and tags `.hermesian-view`, so this measures the sidebar itself without
      // relying on any Obsidian-internal DOM structure.
      getContainerRect: () => {
        const rect = this.sidebarRootEl.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      },
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
      onSaveProviderExpansion: (expansion) =>
        this.plugin.saveModelProviderExpansion?.(expansion),
    });
    this.modelPicker.open();
  }

  async setConversationSelectedModel(
    tabId: string,
    model: HermesModelOption,
    expectedSessionId?: string | null,
  ): Promise<void> {
    if (!this.controller || this.viewClosed) {
      throw new Error("Conversation view is not ready");
    }
    await this.controller.setSelectedModel(tabId, model, expectedSessionId);
  }

  private async chooseModel(tabId: string, model: HermesModelOption): Promise<void> {
    if (this.isTabBusy(tabId)) {
      return;
    }
    try {
      const client = this.plugin.getClient(tabId);
      const expectedSessionId =
        client.sessionId ??
        this.conversationWorkspace?.tabs.find((t) => t.id === tabId)?.sessionId ??
        null;
      await client.setModel(model);
      await this.setConversationSelectedModel(tabId, model, expectedSessionId);
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

  private async chooseHistorySession(session: HermesHistoryEntry): Promise<void> {
    const controller = this.controller;
    if (!controller || !this.conversationWorkspace) return;
    this.captureActiveConversationRuntime();
    const previousActive = this.conversationWorkspace.activeTabId;
    const epoch = this.viewEpoch;
    const opening = controller.openHistorySession(session.sessionId, session.title);
    const pendingActive = this.conversationWorkspace.activeTabId;
    if (pendingActive !== previousActive) {
      this.showConversationMessages(pendingActive);
      this.restoreActiveConversationRuntime();
    }
    try {
      const result = await opening;
      if (this.viewClosed || epoch !== this.viewEpoch || this.controller !== controller) return;
      // History snapshots own rendering; never replay/reset it a second time.
      if (this.conversationWorkspace?.activeTabId === result.tabId && pendingActive !== result.tabId) {
        this.showConversationMessages(result.tabId);
        this.restoreActiveConversationRuntime();
      }
    } catch (_error) {
      // Preserve the requested session, draft and readable history for local retry.
    } finally {
      if (!this.viewClosed && epoch === this.viewEpoch) this.updateControls(false);
    }
  }

  private async renderHistorySession(
    session: HermesHistoryEntry,
    items: readonly HermesHistoryItem[],
    announce = true,
    tabId = this.conversationWorkspace?.activeTabId,
    isCurrent: () => boolean = () => !this.viewClosed,
  ): Promise<void> {
    if (!tabId || !isCurrent()) {
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
      if (!isCurrent()) return;
      if (item.kind === "user") {
        await flushTurn();
        if (!isCurrent()) return;
        this.appendUserMessage(item.text, undefined, undefined, tabId);
      } else {
        turnItems.push(item);
      }
    }
    if (!isCurrent()) return;
    await flushTurn();
    if (!isCurrent()) return;
    if (items.length === 0) {
      this.setTransientSystemMessage("This session has no displayable messages.", tabId);
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
    this.turnRail?.registerTurn(tabId, turn);
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
      this.attachMessageCopyButton(message);
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
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.modelPicker?.detach();
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
    const targetTabId = activeTab.id;
    const currentEffort =
      activeTab.reasoningEffort ?? this.plugin.getReasoningEffort(targetTabId);
    let settled = false;

    this.reasoningPicker = new HermesReasoningPickerPopover({
      anchorEl: this.reasoningButtonEl,
      current: currentEffort,
      iconRenderer: (element, icon) => setIcon(element, icon),
      // Same sidebar content box as the model picker: the width is bounded by
      // the sidebar, never by this trigger button (the two pickers share one
      // formula but are not required to be equally wide).
      getContainerRect: () => {
        const rect = this.sidebarRootEl.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      },
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

  private canCompressContext(): { available: boolean; reason?: string } {
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return { available: false, reason: "未选择会话" };
    }
    if (!activeTab.sessionId) {
      return { available: false, reason: "会话尚未建立连接" };
    }
    if (this.isStopping()) {
      return { available: false, reason: "正在停止…" };
    }
    if (this.hasPendingPermission(activeTab.id)) {
      return { available: false, reason: "等待权限确认…" };
    }
    if (this.isTabBusy(activeTab.id)) {
      return { available: false, reason: "会话正忙，请稍候…" };
    }
    if (this.isTabLoading(activeTab.id)) {
      return { available: false, reason: "会话连接中…" };
    }
    const availability = this.controlAvailability();
    if (!availability.send) {
      return { available: false, reason: "当前无法发送指令" };
    }
    return { available: true };
  }

  private async sendCompressCommand(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (!activeTab || !this.canCompressContext().available) {
      return;
    }
    await this.sendMessage({
      pending: {
        tabId: activeTab.id,
        draft: { token: null, text: "/compress", references: [] },
        images: [],
        includeCurrentDocumentContext: false,
      },
    });
  }

  private toggleContextGaugePopover(): void {
    if (this.contextGaugePopover?.isOpen()) {
      this.contextGaugePopover.detach();
      this.contextGaugePopover = null;
      return;
    }
    this.openContextGaugePopover();
  }

  private openContextGaugePopover(): void {
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.modelPicker?.detach();
    this.modelPicker = null;
    this.reasoningPicker?.detach();
    this.reasoningPicker = null;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;

    const state = this.activeSessionState();
    const canCompress = this.canCompressContext();

    this.contextGaugePopover = new HermesContextGaugePopover({
      anchorEl: this.contextGaugeEl,
      contextUsage: state.contextUsage,
      canCompress,
      getContainerRect: () => {
        const rect = this.sidebarRootEl.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      },
      iconRenderer: (element, icon) => setIcon(element, icon),
      onCompress: async () => {
        await this.sendCompressCommand();
      },
      onClose: () => {
        this.contextGaugePopover = null;
      },
    });
    this.contextGaugePopover.open();
  }

  async setConversationReasoningEffort(tabId: string, effort: ReasoningEffort): Promise<void> {
    if (!this.controller || this.viewClosed) throw new Error("Conversation view is not ready");
    await this.controller.setReasoningEffort(tabId, effort);
  }

  private async chooseReasoningEffort(
    tabId: string,
    effort: ReasoningEffort,
  ): Promise<void> {
    const tab = this.conversationWorkspace?.tabs.find((t) => t.id === tabId);
    if (tab && tab.reasoningEffort === effort) {
      return;
    }
    try {
      await this.plugin.setReasoningEffort(tabId, effort);
      this.renderReasoningButton();
    } catch (error) {
      new Notice(`Hermesian thinking-depth update failed: ${this.messageFor(error)}`);
    }
  }

  private renderReasoningButton(): void {
    const activeTab = this.activeConversationTab();
    const effort =
      activeTab?.reasoningEffort ??
      this.plugin.getReasoningEffort(activeTab?.id);
    const client = activeTab ? this.plugin.peekClient(activeTab.id) : undefined;
    const applied = client?.appliedReasoningEffort;
    const nextTurn = Boolean(activeTab && this.isTabBusy(activeTab.id) && applied !== undefined && applied !== effort);
    // Compact control capsule: the visible label is the bare effort word only
    // (no "Thinking: " prefix, no " (next turn)" suffix). The next-turn pending
    // state is preserved in the tooltip and accessible name below.
    const label = reasoningEffortLabel(effort);
    this.reasoningLabelEl.setText(label);
    const description = nextTurn ? `Active: ${reasoningEffortLabel(applied!)} · Next turn: ${label}` : label;
    this.reasoningButtonEl.setAttribute("title", description);
    this.reasoningButtonEl.setAttribute("aria-label", description);
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
    this.renderReasoningButton();
    this.renderConversationTabs();
    const current = state.currentModel;
    // Compact control capsule: the visible label is the model's own id only;
    // provider identity moves to the tooltip (and stays in the accessible name).
    const label = state.switchingModel
      ? "Switching model…"
      : current
        ? current.modelId
        : state.catalogLoading
          ? "Loading models…"
          : "Model unavailable";
    this.modelLabelEl.setText(label);
    this.modelButtonEl.disabled = !availability.model || state.models.length === 0;
    this.modelButtonEl.setAttribute(
      "aria-label",
      current ? `${current.providerName} ${current.modelId}` : label,
    );
    this.modelButtonEl.setAttribute(
      "title",
      current ? `${current.providerName} · ${current.modelId}` : label,
    );

    const usageText = formatContextUsage(state.contextUsage);
    const level = contextUsageLevel(state.contextUsage);
    const percent = contextUsagePercent(state.contextUsage);

    this.contextGaugeEl.setAttribute("aria-label", usageText);
    this.contextGaugeEl.setAttribute("title", usageText);
    this.contextGaugeEl.dataset.level = level;
    if (this.contextGaugeFillEl) {
      // Circumference for r=7 is 2 * π * 7 ≈ 43.98
      const circumference = 43.98;
      const offset = (circumference * (1 - percent / 100)).toFixed(2);
      this.contextGaugeFillEl.style.strokeDashoffset = `${offset}`;
      this.contextGaugeFillEl.style.opacity = percent === 0 ? "0" : "1";
    }
    if (this.contextGaugePopover?.isOpen()) {
      this.contextGaugePopover.update(state.contextUsage, this.canCompressContext());
    }
    if (this.titlePopover?.isOpen()) {
      const popoverTabId = this.titlePopover.getTabId();
      this.titlePopover.updateAiOptions({
        models: this.getAvailableTitleModels(popoverTabId),
        catalogLoading: state.catalogLoading || this.titleCatalogLoading,
        hiddenModelSwitchIds: this.plugin.settings.hiddenModelSwitchIds,
      });
    }
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

  private handleComposerKeydown(event: KeyboardEvent): void {
    if (this.hasPendingSend()) return;
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
      if (
        this.composerDraft.text.length === 0 &&
        this.composerDraft.references.length === 0
      ) {
        this.renderSlashMenu(true);
      }
      this.composerEl.focus();
    }
  }

  private handleSlashMenuKeydown(event: KeyboardEvent): boolean {
    if (this.slashMenuItems.length === 0) {
      return false;
    }
    if (event.isComposing || event.keyCode === 229) {
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
    const label = this.currentFilePath
      ? noteTitle(this.currentFilePath)
      : "No active file";
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
        : "Open a file to use its path as context",
    );
    this.currentFileBarEl.dataset.empty = this.currentFilePath ? "false" : "true";
  }

  private async handleComposerPaste(event: ClipboardEvent): Promise<void> {
    if (this.hasPendingSend()) { event.preventDefault(); return; }
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

    // A paste begun before Send must not race an immutable waiting intent.
    this.pendingSends.cancel(tabId);
    const current = this.pendingImages.get(tabId) ?? [];
    this.pendingImages.set(tabId, [...current, ...attachments].slice(0, 4));
    if (this.conversationWorkspace?.activeTabId === tabId) {
      this.renderImageAttachmentBar();
      this.updateControls(false);
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
        if (!tabId || this.pendingSends.has(tabId)) {
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
    const caption = buildSelectionCaption(this.pendingSelection);
    const label = this.selectionBarEl.createSpan({ text: caption.text });
    label.setAttribute("title", caption.title);
    const remove = this.selectionBarEl.createEl("button", {
      attr: { "aria-label": "Remove selection context" },
      cls: "clickable-icon",
    });
    setIcon(remove, "x");
    remove.addEventListener("click", () => {
      if (this.hasPendingSend()) return;
      this.pendingSelection = undefined;
      this.renderSelectionBar();
      this.captureActiveConversationRuntime();
    });
  }

  private hasPendingSend(): boolean {
    return this.pendingSends.has(this.conversationWorkspace?.activeTabId ?? "");
  }

  private async waitToSend(tabId: string): Promise<void> {
    if (this.dictationPhase !== "idle") {
      this.composerHint = "Finish dictation before sending.";
      this.updateControls(false);
      return;
    }
    const controller = this.controller;
    if (!controller || this.pendingSends.has(tabId)) return;
    const routing = composerInlineDraftRouting(this.composerDraft);
    const images = routing.hasSlashInvocation ? [] : [...(this.pendingImages.get(tabId) ?? [])];
    if (!this.getComposerCanonicalDraft().trim() && !images.length) return;
    const selection = routing.isNativeSlashCommand ? undefined : this.pendingSelection;
    const include = !routing.isNativeSlashCommand && !selection && this.includeCurrentDocumentContext;
    const activeNotePath = include ? this.plugin.getCurrentFilePath() : undefined;
    const activeNoteAbsolutePath =
      include && activeNotePath
        ? this.plugin.getMarkdownAbsolutePath?.(activeNotePath)
        : undefined;
    const payload: PendingComposerSend = {
      tabId, draft: structuredClone(this.composerDraft), images, selection,
      includeCurrentDocumentContext: this.includeCurrentDocumentContext,
      activeNotePath,
      activeNoteAbsolutePath,
    };
    const entry = this.pendingSends.add(tabId, payload);
    if (!entry) return;
    const epoch = this.viewEpoch;
    this.captureActiveConversationRuntime();
    this.updateControls(false);
    try {
      await controller.ensureConversationReady(tabId);
      await this.historyRendering.get(tabId);
      if (this.viewClosed || this.viewEpoch !== epoch || this.controller !== controller) return;
      const pending = this.pendingSends.take(tabId, entry);
      if (!pending) return;
      // Readiness never authorizes bypassing a permission or a turn that won the race.
      if (!this.tabControlAvailability(tabId).send || this.isTabBusy(tabId) || this.hasPendingPermission(tabId)) {
        if (this.conversationWorkspace?.activeTabId === tabId) {
          this.composerHint = "Message not sent. Review this conversation and send again.";
        }
        return;
      }
      await this.sendMessage({ pending });
    } catch (_error) {
      if (this.pendingSends.take(tabId, entry) && this.conversationWorkspace?.activeTabId === tabId) {
        this.composerHint = "Connection failed. Message retained; retry connection, then send again.";
      }
    } finally {
      if (!this.viewClosed && this.viewEpoch === epoch) this.updateControls(false);
    }
  }

  private async sendMessage(
    options: {
      fromStopAndSend?: boolean;
      pending?: PendingComposerSend;
      /** Restore this composer text right after outbound dispatch, before the turn awaits. */
      restoreComposerAfterDispatch?: string;
      /**
       * Stop-and-send: fire once the snapshot is on the outbound wire so the
       * coordinator can leave Stopping… before await sendPrompt.
       */
      onStopAndSendDispatched?: () => void;
    } = {},
  ): Promise<void> {
    const pending = options.pending;
    const activeTab = pending
      ? this.conversationWorkspace?.tabs.find((tab) => tab.id === pending.tabId)
      : this.activeConversationTab();
    if (!pending && !options.fromStopAndSend && activeTab &&
        this.controller?.getSnapshot().tabOperations.get(activeTab.id)?.connection !== "ready") {
      if (this.controlAvailability().send) await this.waitToSend(activeTab.id);
      return;
    }
    // Finish any history projection before creating a live turn; otherwise a
    // delayed Markdown render could interleave restored rows with the new turn.
    const historyRendering = activeTab ? this.historyRendering.get(activeTab.id) : undefined;
    if (historyRendering && !pending) await historyRendering;
    if (this.viewClosed) return;
    const visible = () => this.conversationWorkspace?.activeTabId === activeTab?.id;
    const draft = pending?.draft ?? this.composerDraft;
    const pendingSelection = pending ? pending.selection : this.pendingSelection;
    const includeCurrentDocumentContext = pending?.includeCurrentDocumentContext ?? this.includeCurrentDocumentContext;
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
      !(pending ? this.tabControlAvailability(activeTab.id).send : this.controlAvailability().send) ||
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
      if (!pending && !options.fromStopAndSend) {
        await this.waitToSend(activeTab.id);
        return;
      }
      try {
        await this.ensureClientForTab(activeTab.id);
      } catch (error) {
        if (options.fromStopAndSend) {
          throw error instanceof Error ? error : new Error(this.messageFor(error));
        }
        this.composerHint = "Connection failed. Message retained; retry connection, then send again.";
        this.renderReadinessStatus();
        return;
      }
    }
    if (
      (!pending && !isActiveConversationSession(
        this.conversationWorkspace,
        activeTab.id,
        activeTab.sessionId,
      )) ||
      client.sessionId !== activeTab.sessionId
    ) {
      if (options.fromStopAndSend) {
        throw new Error("Conversation session is no longer active for stop-and-send.");
      }
      return;
    }
    const rawRequest = serializeComposerInlineDraft(draft).trim();
    // Two separate states: any slash invocation (menu token or free-typed
    // slash text) keeps the image/slash exclusivity, while a menu-selected
    // skill still routes like an ordinary model request (selection/document/
    // off context handling below). Native control commands stay bare.
    const { hasSlashInvocation, isSkill, isNativeSlashCommand } =
      composerInlineDraftRouting(draft);
    const pendingImages = hasSlashInvocation
      ? []
      : pending?.images ?? this.pendingImages.get(activeTab.id) ?? [];
    if (pendingImages.length > 0 && !client.supportsImagePrompts) {
      if (options.fromStopAndSend) {
        throw new Error("The connected Hermes agent does not support image prompts.");
      }
      new Notice("The connected Hermes agent does not support image prompts.");
      return;
    }
    const request =
      rawRequest ||
      (pendingImages.length > 0
        ? "Please analyze the pasted image and respond to my request."
        : "");
    if (!request) {
      if (options.fromStopAndSend) {
        throw new Error("Stop-and-send snapshot is empty.");
      }
      return;
    }

    const selection = isNativeSlashCommand ? undefined : pendingSelection;
    // The current note's identity (path) is only ever read when the context
    // capsule is on; with the capsule off, this send path cannot obtain the
    // current note's path at all, so it cannot leak it to Hermes.
    const includeNotePath =
      !isNativeSlashCommand && !selection && includeCurrentDocumentContext;
    let activeNotePath: string | undefined;
    let activeNoteAbsolutePath: string | undefined;
    if (includeNotePath) {
      activeNotePath = pending
        ? pending.activeNotePath
        : this.plugin.getCurrentFilePath();
      activeNoteAbsolutePath = activeNotePath
        ? (pending
            ? pending.activeNoteAbsolutePath
            : this.plugin.getMarkdownAbsolutePath?.(activeNotePath))
        : undefined;
      if (visible()) this.setCurrentFile(activeNotePath);
    }
    const prompt = buildOutboundPrompt({
      request,
      isSlashCommand: isNativeSlashCommand,
      isSkill,
      includeCurrentDocumentContext,
      selection,
      activeNotePath,
      activeNoteAbsolutePath,
    });
    const runtime = this.turnRuntime(activeTab.id);
    const notePath = !isNativeSlashCommand
      ? (selection?.filePath ?? activeNotePath)
      : undefined;
    this.editScopes.set(activeTab.id, notePath ? { filePath: notePath } : undefined);
    const noteCaption =
      !selection && includeNotePath && activeNotePath
        ? buildDocumentCaption(activeNotePath)
        : undefined;
    this.appendUserMessage(
      request,
      selection,
      undefined,
      activeTab.id,
      pendingImages,
      noteCaption?.text,
      noteCaption?.title,
      { animate: true },
    );
    if (visible()) {
      this.setComposerSlashToken(null);
      this.composerDraft = { token: null, text: "", references: [] };
      this.renderComposerInlineDraft();
      this.hideSlashMenu();
      if (!isNativeSlashCommand) this.pendingSelection = undefined;
      this.renderSelectionBar();
    }
    if (!isNativeSlashCommand) this.tabSelections.delete(activeTab.id);
    this.pendingImages.delete(activeTab.id);
    if (visible()) {
      this.renderImageAttachmentBar();
      this.captureActiveConversationRuntime();
    } else if (this.conversationWorkspace) {
      this.conversationWorkspace = updateConversationTab(this.conversationWorkspace, activeTab.id, {
        draft: "", token: undefined, references: [], includeCurrentDocumentContext,
      });
      this.plugin.setConversationWorkspace(this.conversationWorkspace);
    }
    this.resetStreamingMessage(activeTab.id);
    this.clearQueuedSteers(activeTab.id);
    runtime.busy = true;
    this.controller?.setPromptRunning(activeTab.id, true);
    runtime.turnActivityEl = undefined;
    runtime.activeTurnEl = this.messageContainer(activeTab.id).createDiv({
      cls: "hermesian-turn",
    });
    this.turnRail?.registerTurn(activeTab.id, runtime.activeTurnEl);
    this.turnRail?.setActiveTurn(activeTab.id, true);
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
      await client.sendPrompt(promptContent, {
        reasoningEffort: activeTab?.reasoningEffort,
      });
    } catch (error) {
      new Notice(`Hermesian: ${this.messageFor(error)}`);
      const notDispatched = error instanceof Error && "promptNotDispatched" in error && error.promptNotDispatched === true;
      if ((pending || notDispatched) && this.conversationWorkspace?.tabs.some((tab) => tab.id === activeTab.id)) {
        // Keep failed connection/preflight content recoverable without automatically resending.
        const current = this.conversationWorkspace.tabs.find((tab) => tab.id === activeTab.id)!;
        if (!current.draft) {
          this.conversationWorkspace = updateConversationTab(this.conversationWorkspace, activeTab.id, {
            draft: serializeComposerInlineDraft(draft), token: draft.token ?? undefined,
            references: draft.references, includeCurrentDocumentContext,
          });
          this.plugin.setConversationWorkspace(this.conversationWorkspace);
          this.tabSelections.set(activeTab.id, pendingSelection);
          if (visible()) this.restoreActiveConversationRuntime();
        }
      }
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
    const tabId = this.conversationWorkspace?.activeTabId;
    if (tabId && this.pendingSends.has(tabId)) return;
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

  private showSteerPendingChip(text: string): void {
    if (this.steerPendingTextEl) {
      this.steerPendingTextEl.textContent = formatSteerPendingPreview(text);
    }
    if (this.steerPendingRowEl) {
      this.steerPendingRowEl.show();
    }
  }

  private hideSteerPendingChip(): void {
    if (this.steerPendingRowEl) {
      this.steerPendingRowEl.hide();
    }
    if (this.steerPendingTextEl) {
      this.steerPendingTextEl.textContent = "";
    }
  }

  private async steerActiveTurnFromComposer(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (!activeTab || this.steerInFlight || !this.controlAvailability().steer) {
      this.hideSteerPendingChip();
      return;
    }
    const text = this.composerDraft.text.trim();
    if (!text) {
      this.hideSteerPendingChip();
      return;
    }
    const client = this.plugin.getClient(activeTab.id);
    if (!client) {
      this.hideSteerPendingChip();
      return;
    }

    const frozen = {
      token: this.composerDraft.token,
      text: this.composerDraft.text,
      references: [...this.composerDraft.references],
    };

    // 1. Clear draft text synchronously (retaining token/references).
    this.composerDraft = {
      token: this.composerDraft.token,
      text: "",
      references: this.composerDraft.references,
    };
    this.renderComposerInlineDraft();
    this.captureActiveConversationRuntime();

    // 2. Show steering chip & enter in-flight state.
    this.steerInFlight = true;
    this.composerHint = undefined;
    this.showSteerPendingChip(text);
    this.updateControls(false);

    let result: SteerResult;
    try {
      result = await client.steerActiveTurn(text);
    } catch {
      this.steerInFlight = false;
      this.hideSteerPendingChip();
      this.composerDraft = {
        token: frozen.token,
        text: frozen.text,
        references: [...frozen.references],
      };
      this.renderComposerInlineDraft();
      this.captureActiveConversationRuntime();
      this.composerHint = "Steer did not land — your text is back in the composer.";
      this.updateControls(false);
      this.composerEl.focus();
      return;
    }

    this.steerInFlight = false;
    this.hideSteerPendingChip();

    const steerDisposition = shouldRecordSteer(result);
    if (steerDisposition.record) {
      this.appendSteerRecord(activeTab.id, text, steerDisposition.queued);
    }
    if (result.ok) {
      this.composerHint = undefined;
      this.updateControls(false);
      this.composerEl.focus();
      return;
    }
    if (result.reason === "queued") {
      this.composerHint = "Steer queued — it will run as its own turn when the current one finishes.";
      this.updateControls(false);
      this.composerEl.focus();
      return;
    }

    // failed: silent draft restore, gentle hint, no Notice.
    this.composerDraft = {
      token: frozen.token,
      text: frozen.text,
      references: [...frozen.references],
    };
    this.renderComposerInlineDraft();
    this.captureActiveConversationRuntime();
    this.composerHint = "Steer did not land — your text is back in the composer.";
    this.updateControls(false);
    this.composerEl.focus();
  }

  private async handleComposerStop(): Promise<void> {
    const activeTab = this.activeConversationTab();
    if (!activeTab) {
      return;
    }
    if (this.pendingSends.has(activeTab.id)) {
      this.pendingSends.cancel(activeTab.id);
      this.updateControls(false);
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
          stopAvailable: this.hasPendingSend() || availability.stop === true,
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
        this.titlePopover ||
        this.contextGaugePopover ||
        this.permissions.size > 0
      ) {
        return;
      }
      event.preventDefault();
      void this.handleComposerStop();
    });
  }

  private bindConversationShortcuts(): void {
    if (this.conversationShortcutsBound) {
      return;
    }
    this.conversationShortcutsBound = true;
    this.registerDomEvent(this.containerEl.ownerDocument, "keydown", (event: KeyboardEvent) => {
      const shortcut = conversationShortcutForEvent(event);
      if (!shortcut || !this.isHermesianInteractionFocused()) {
        return;
      }
      const activeTab = this.activeConversationTab();
      if (!activeTab) {
        return;
      }
      // Always consume the matching key inside Hermesian, even when its
      // normal tab guard refuses the action. No Option character should leak
      // into the draft or trigger another Obsidian handler.
      event.preventDefault();
      event.stopPropagation();
      // Keyboard shortcuts do not cause the pickers' pointer-down outside
      // handler to run. Close them so a later choice cannot target the tab
      // that was active before this shortcut switched or closed it.
      this.modelPicker?.detach();
      this.modelPicker = null;
      this.reasoningPicker?.detach();
      this.reasoningPicker = null;
      if (shortcut === "add") {
        void this.addConversation();
      } else {
        void this.closeConversation(activeTab.id);
      }
    });
  }

  private isHermesianInteractionFocused(): boolean {
    const activeElement = this.containerEl.ownerDocument.activeElement;
    if (!activeElement) {
      return false;
    }
    return (
      this.containerEl.contains(activeElement) ||
      Boolean(
        this.titlePopover?.contains(activeElement) ||
        this.modelPicker?.contains(activeElement) ||
        this.reasoningPicker?.contains(activeElement) ||
        this.contextGaugePopover?.contains(activeElement)
      )
    );
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

  /**
   * Insert an absolute path chosen from the file/folder picker as an inline
   * reference capsule at the caret captured when the dialog opened (fallback:
   * end of draft). The absolute path is resolved via Electron's
   * `webUtils.getPathForFile` (authoritative; `File.path` is gone since
   * Electron 32), falling back to the legacy `File.path` when webUtils is
   * unavailable, and silently skipped when neither exists (browser mode).
   * Folder picks yield the folder itself by stripping the
   * `webkitRelativePath` suffix from the first file's path.
   */
  private insertPickedFileReference(
    input: HTMLInputElement,
    folderMode: boolean,
  ): void {
    // Availability guard FIRST — a disabled composer must never insert.
    if (!this.controlAvailability().composer || this.hasPendingSend()) {
      input.value = "";
      return;
    }
    // Caret was captured in onFilePickerOpen while the editor still had
    // focus (the native dialog steals it before the change event fires).
    const caretOffset =
      this.pendingFilePickerCaret ?? this.composerDraft.text.length;
    this.pendingFilePickerCaret = null;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const filePath = resolvePickedFilePath(file, electronWebUtilsResolver);
    if (!filePath) {
      input.value = "";
      new Notice("Hermesian could not access the selected file path.");
      return;
    }
    let value = filePath;
    if (folderMode) {
      const relative =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
      if (!relative) {
        input.value = "";
        return;
      }
      const derived = derivePickedFolderPath(filePath, relative);
      if (derived === null) {
        input.value = "";
        return;
      }
      value = derived;
    }
    this.composerDraft = insertInlineReference(this.composerDraft, caretOffset, {
      kind: "path",
      value,
    });
    this.composerHint = undefined;
    // Focus lands explicitly right after the newly inserted capsule.
    this.renderComposerInlineDraft(caretOffset + value.length);
    this.captureActiveConversationRuntime();
    this.updateControls(false);
    this.composerEl.focus();
    // Reset so picking the same path again still fires `change`.
    input.value = "";
  }

  private updateControls(_busy: boolean, _showStop = _busy): void {
    const availability = this.controlAvailability();
    if (!availability.composer) {
      this.hideSlashMenu();
    }
    const waiting = this.pendingSends.has(this.conversationWorkspace?.activeTabId ?? "");
    const stopping = this.isStopping();
    const primaryMode = composerPrimaryMode({
      stopping,
      stopAvailable: waiting || availability.stop === true,
      steerAvailable: availability.steer === true && !this.steerInFlight,
    });
    applyComposerState(
      {
        composerEl: this.composerEl,
        sendButtonEl: this.sendButtonEl,
        stopButtonEl: this.stopButtonEl,
        steerButtonEl: this.steerButtonEl,
        steerModeEl: this.steerModeEl,
        dictationButtonEl: this.dictationButtonEl,
        filePickerButtonEl: this.filePickerButtonEl,
        filePickerMenuEl: this.filePickerMenuEl,
        statusEl: this.composerStatusEl,
        hintEl: this.composerHintEl,
      },
      {
        disabled: !availability.composer || waiting,
        draft: this.composerDraft,
        placeholder: this.composerPlaceholder(),
        sendEnabled: availability.send && !stopping,
        stopVisible: primaryMode !== "send",
        primaryMode,
        stopEnabled: waiting || (availability.stop === true && !stopping),
        steerEnabled: availability.steer === true && !this.steerInFlight && !stopping,
        dictationPhase: this.dictationPhase,
        dictationEnabled: availability.composer === true && !waiting,
        hint: this.composerHint,
      },
    );
    if (waiting) {
      this.composerStatusEl.setText("Waiting for connection… Cancel to edit.");
      this.stopButtonEl.setAttribute("aria-label", "Cancel pending send");
      this.stopButtonEl.title = "Cancel pending send";
    }
    this.renderAddConversationControl();
    this.historyButtonEl.disabled = !availability.history;
    this.reasoningButtonEl.disabled = !availability.reasoning;
    this.renderConversationTabs();
    this.renderSessionState(this.activeSessionState());
    this.renderReadinessStatus();
  }

  async startNewSession(): Promise<void> {
    this.titlePopover?.detach();
    this.titlePopover = null;
    this.contextGaugePopover?.detach();
    this.contextGaugePopover = null;
    const activeTab = this.activeConversationTab();
    if (
      !this.controller ||
      !activeTab ||
      !this.controlAvailability().restart ||
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
      this.setTransientSystemMessage("New Hermes session started.", tabId);
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

  async cycleConversationTab(direction: 1 | -1 = 1): Promise<void> {
    if (!this.controlAvailability().tabNavigation) {
      return;
    }
    const targetTabId = cycleConversationTabId(
      this.conversationWorkspace,
      direction,
      (tabId) => !this.isTabClosing(tabId),
    );
    if (targetTabId) {
      await this.switchConversation(targetTabId);
      this.composerEl?.focus();
    }
  }

  private appendUserMessage(
    text: string,
    selection?: SelectionContext,
    documentContext?: { filePath: string },
    tabId = this.conversationWorkspace?.activeTabId,
    images: readonly PastedImageAttachment[] = [],
    contextChip?: string,
    contextChipTitle?: string,
    options?: { animate?: boolean },
  ): HTMLElement {
    if (tabId && text.trim() && this.tabFirstUserMessages && !this.tabFirstUserMessages.has(tabId)) {
      this.tabFirstUserMessages.set(tabId, text.trim());
      this.renderConversationTabs?.();
    }
    this.clearTransientSystemMessage?.(tabId);
    const parent = tabId ? this.messageContainer(tabId) : this.messagesEl;
    const isVisibleTab = this.messageRenderer
      ? (tabId ? this.messageRenderer.isVisible(tabId) : true)
      : (this.conversationWorkspace ? tabId === this.conversationWorkspace.activeTabId : true);
    const shouldAnimate = (options?.animate ?? false) && isVisibleTab;
    const message = parent.createDiv({
      cls: `hermesian-message is-user${shouldAnimate ? " is-entering" : ""}`,
    });
    if (shouldAnimate) {
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        message.classList.remove("is-entering");
      };
      message.addEventListener?.("animationend", cleanup, { once: true });
      setTimeout(cleanup, 290);
    }
    if (selection) {
      const caption = buildSelectionCaption(selection);
      const chip = message.createDiv({
        text: caption.text,
        cls: "hermesian-message-context",
      });
      chip.setAttribute("title", caption.title);
    } else if (documentContext) {
      // A caller-supplied contextChip carries the note-changed marker and is
      // rendered verbatim; the plain full-note chip is a display caption.
      if (contextChip) {
        const chip = message.createDiv({
          text: contextChip,
          cls: "hermesian-message-context",
        });
        chip.setAttribute("title", contextChipTitle ?? contextChip);
      } else {
        const caption = buildDocumentCaption(documentContext.filePath);
        const chip = message.createDiv({
          text: caption.text,
          cls: "hermesian-message-context",
        });
        chip.setAttribute("title", caption.title);
      }
    } else if (contextChip) {
      // changed-note marker with only an active-note path (no captured body)
      const chip = message.createDiv({
        text: contextChip,
        cls: "hermesian-message-context",
      });
      chip.setAttribute("title", contextChipTitle ?? contextChip);
    }
    // Display-layer safety net: any user text that is exactly an outbound
    // prompt product (envelope and/or context wrapper from resume/load
    // history replay) renders as the bare request. Idempotent for
    // already-stripped or ordinary text.
    const displayText = stripUserPromptForDisplay(text);
    message.createDiv({
      text: displayText,
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
    if (this.turnRail && tabId) {
      this.turnRail.registerUserMessage(tabId, message, displayText);
    }
    // Sending / replaying a user bubble means intent to follow the latest output.
    this.scrollToBottom(tabId, { force: true });
    return message;
  }

  private appendAssistantDelta(tabId: string, text: string, messageId?: string): void {
    if (messageId) {
      const previous = this.lastAssistantMessageId.get(tabId);
      if (previous && previous !== messageId) {
        // A new gateway reply (e.g. a server-initiated queued steer turn):
        // finalize the previous bubble before the new one starts, and retire
        // queued steer markers — the queued turn is now on screen.
        void this.finalizeAssistantMessage(tabId);
        this.clearQueuedSteers(tabId);
      }
      this.lastAssistantMessageId.set(tabId, messageId);
    }
    this.turnManager.appendDelta(tabId, text);
    this.scrollToBottom(tabId);
  }

  private appendThoughtDelta(tabId: string, text: string): void {
    this.turnManager.appendThought(tabId, text);
    this.scrollToBottom(tabId);
  }

  private async handleTurnSplit(tabId: string, text: string): Promise<void> {
    const runtime = this.turnRuntime(tabId);
    let target = runtime.assistantContentEl;
    let body = runtime.assistantText;
    runtime.assistantContentEl = undefined;
    runtime.assistantText = "";
    runtime.thoughtContentEl = undefined;
    if (!target) {
      const streamingEl = this.messageRenderer
        ?.containerFor(tabId)
        .querySelector<HTMLElement>(".hermesian-message-content.is-streaming");
      if (streamingEl) {
        target = streamingEl;
        if (!body) {
          // appendSteer detaches the streaming container mid-turn and drops
          // the runtime body; recover it from live DOM text so the orphaned
          // container still renders instead of staying raw.
          body = streamingEl.textContent ?? "";
        }
      }
    }
    this.turnManager.splitTurn(tabId);
    this.appendUserMessage(text, undefined, undefined, tabId);
    this.clearQueuedSteers(tabId);

    if (target && body) {
      await this.renderMarkdown(target, body, this.editScopes.get(tabId)?.filePath);
      this.scrollToBottom(tabId);
    } else if (target) {
      target.classList.remove("is-streaming");
    }
  }

  private scheduleUsageFinalize(tabId: string): void {
    if (this.pendingUsageFinalizes.has(tabId)) {
      return;
    }
    this.pendingUsageFinalizes.add(tabId);
    queueMicrotask(() => {
      this.pendingUsageFinalizes.delete(tabId);
      const runtime = this.turnRuntime(tabId);
      const container = this.messageRenderer?.containerFor(tabId);
      const hasStreaming = Boolean(
        runtime.assistantContentEl ||
        container?.querySelector(".hermesian-message-content.is-streaming")
      );
      if (hasStreaming) {
        if (runtime.thoughtDetailsEl) {
          runtime.thoughtDetailsEl.open = false;
        }
        void this.finalizeAssistantMessage(tabId);
      }
    });
  }

  private async finalizeAssistantMessage(tabId: string): Promise<void> {
    const runtime = this.turnRuntime(tabId);
    let target = runtime.assistantContentEl;
    let text = runtime.assistantText;
    runtime.assistantContentEl = undefined;
    runtime.assistantText = "";
    runtime.thoughtContentEl = undefined;
    if (!target) {
      const streamingEl = this.messageRenderer
        ?.containerFor(tabId)
        .querySelector<HTMLElement>(".hermesian-message-content.is-streaming");
      if (streamingEl) {
        target = streamingEl;
        if (!text) {
          text = streamingEl.textContent ?? "";
        }
      }
    }
    if (!target) {
      return;
    }
    if (!text) {
      target.classList.remove("is-streaming");
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
    target.classList.remove("is-streaming");
    const sourcePath = sourceFilePath ?? this.currentFilePath ?? "";
    target.dataset.sourcePath = sourcePath;

    const { processedText, mermaidBlocks } = extractMermaidBlocks(text);

    // Table and math normalization see the original code; the guard runs last
    // so Obsidian never receives code another plugin would execute.
    let guardedText = normalizeTableSpacing(normalizeMathDelimiters(processedText));
    let guardedCode: GuardedCodeFragment[] = [];
    try {
      const guarded = extractGuardedCode(guardedText);
      guardedText = guarded.processedText;
      guardedCode = guarded.fragments;
    } catch (error) {
      // Without the guard the message still renders, only unprotected.
      this.logger.warn("controller.background.failure", {
        operation: "guard-code",
        ...safeErrorFields(error),
      });
    }

    await MarkdownRenderer.render(this.app, guardedText, target, sourcePath, this);

    restoreGuardedCode(target, guardedCode);
    replaceMermaidPlaceholders(target, mermaidBlocks, this.app);

    linkifyExternalUrls(target);

    if (this.isAssistantMessageTarget(target)) {
      this.enhanceAssistantTables(target, sourcePath);
    }
  }

  private isAssistantMessageTarget(target: HTMLElement): boolean {
    const messageEl = target.closest(".hermesian-message");
    if (messageEl) {
      return messageEl.classList.contains("is-assistant");
    }
    return !target.classList.contains("is-user") && !target.closest(".is-user");
  }

  private enhanceAssistantTables(target: HTMLElement, sourcePath: string): void {
    const tables = Array.from(target.querySelectorAll<HTMLTableElement>("table"));
    for (const table of tables) {
      if (table.parentElement?.classList.contains("hermesian-table-frame")) {
        continue;
      }

      const frame = document.createElement("div");
      frame.className = "hermesian-table-frame";

      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "hermesian-table-expand-button";
      expandBtn.setAttribute("aria-label", "展开看全表");
      expandBtn.setAttribute("title", "展开看全表");
      try {
        setIcon(expandBtn, "maximize-2");
      } catch {
        // Fallback for non-Obsidian environments
      }

      expandBtn.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const clonedTable = table.cloneNode(true) as HTMLTableElement;
        const modal = new TableModal(this.app, clonedTable, {
          sourcePath: target.dataset.sourcePath ?? sourcePath ?? this.currentFilePath,
          onLinkClick: (linkEvent: MouseEvent) => {
            this.openRenderedLink(linkEvent);
          },
        });
        modal.open();
      });

      const parent = table.parentElement;
      if (parent) {
        parent.insertBefore(frame, table);
      }
      frame.appendChild(expandBtn);
      frame.appendChild(table);
    }
  }

  private openRenderedLink(event: MouseEvent): void {
    handleRenderedLinkClick(event, this.app, this.currentFilePath);
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

  private appendSteerRecord(
    tabId: string,
    text: string,
    queued = false,
  ): HTMLElement | undefined {
    if (
      this.viewClosed ||
      !this.conversationWorkspace?.tabs.some((tab) => tab.id === tabId)
    ) {
      return undefined;
    }
    const el = this.turnManager.appendSteer(tabId, text, queued);
    this.scrollToBottom(tabId);
    return el;
  }

  private clearQueuedSteers(tabId: string): void {
    this.turnManager.clearQueuedSteers(tabId);
  }

  private resetConversationView(tabId: string): void {
    this.tabFirstUserMessages?.delete(tabId);
    this.transientSystemMessages?.delete(tabId);
    this.lastAssistantMessageId.delete(tabId);
    this.turnManager.resetView(tabId);
    this.turnRail?.clearTab(tabId);
    this.updateComposerPlaceholder();
  }

  private renderToolEvent(
    tabId: string,
    event: Extract<HermesUiEvent, { type: "tool" }>,
  ): void {
    const runtime = this.turnRuntime(tabId);
    let element = runtime.toolEls.get(event.id);
    if (!element) {
      const isDelegation = event.title.startsWith("delegate_task:");
      element = isDelegation
        ? (this.ensureTurnActivity(tabId).createEl("details", {
            cls: "hermesian-delegation",
          }) as HTMLDetailsElement)
        : this.ensureTurnActivity(tabId).createDiv({ cls: "hermesian-tool" });
      runtime.toolEls.set(event.id, element);
    }
    const isDelegation =
      (typeof HTMLDetailsElement !== "undefined" && element instanceof HTMLDetailsElement) ||
      element.tagName.toUpperCase() === "DETAILS";
    if (isDelegation) {
      const details = element as HTMLDetailsElement;
      const isFinished =
        event.status === "completed" || event.status === "failed";
      details.open = !isFinished;
      element.empty();
      const summary = details.createEl("summary");
      const icon = summary.createSpan();
      setIcon(icon, event.kind === "edit" ? "file-pen-line" : "wrench");
      summary.createSpan({ text: event.title, cls: "hermesian-tool-title" });
      summary.createSpan({
        text: event.status ?? "pending",
        cls: "hermesian-tool-status",
      });
      if (event.content) {
        details.createEl("pre", { text: event.content });
      }
    } else {
      element.empty();
      const icon = element.createSpan();
      setIcon(icon, event.kind === "edit" ? "file-pen-line" : "wrench");
      element.createSpan({ text: event.title, cls: "hermesian-tool-title" });
      element.createSpan({
        text: event.status ?? "pending",
        cls: "hermesian-tool-status",
      });
    }
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

  private setTransientSystemMessage(
    text: string,
    tabId = this.conversationWorkspace?.activeTabId,
    options?: { loading?: boolean },
  ): void {
    const key = tabId ?? "__root__";
    this.transientSystemMessages.get(key)?.remove?.();
    if (key !== "__root__") {
      this.transientSystemMessages.get("__root__")?.remove?.();
      this.transientSystemMessages.delete("__root__");
    }
    const parent = tabId ? this.messageContainer(tabId) : this.messagesEl;
    const isVisibleTab = this.messageRenderer
      ? (tabId ? this.messageRenderer.isVisible(tabId) : true)
      : (this.conversationWorkspace ? tabId === this.conversationWorkspace.activeTabId : true);
    const loading = options?.loading === true;
    const message = parent.createDiv({
      attr: {
        "aria-live": "polite",
        role: "status",
      },
      cls: `hermesian-system is-transient${loading ? " is-loading" : ""}${isVisibleTab ? " is-swapping" : ""}`,
    });
    if (loading) {
      message.createSpan({
        cls: "hermesian-system-flow-text",
        text,
      });
    } else {
      message.setText(text);
    }
    if (isVisibleTab) {
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        message.classList.remove("is-swapping");
      };
      message.addEventListener?.("animationend", cleanup, { once: true });
      setTimeout(cleanup, 280);
    }
    this.transientSystemMessages.set(key, message);
    this.scrollToBottom(tabId);
  }

  private clearTransientSystemMessage(tabId?: string): void {
    const map = this.transientSystemMessages;
    if (!map) {
      return;
    }
    if (tabId) {
      map.get(tabId)?.remove?.();
      map.delete(tabId);
    }
    map.get("__root__")?.remove?.();
    map.delete("__root__");
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
   * Icons are injected by the host (Obsidian's setIcon). When `caretOffset`
   * is provided the caret is placed there after the re-render (used to land
   * focus right after a newly inserted capsule).
   */
  private renderComposerInlineDraft(caretOffset?: number): void {
    renderInlineDraft(
      this.composerEl,
      this.composerDraft,
      this.inlineRenderOptions(),
      caretOffset,
    );
  }

  private inlineRenderOptions(): InlineEditorRenderOptions {
    return {
      onRemoveReference: (index) => {
        this.removeComposerReference(index);
      },
      renderIcon: (iconEl, kind) => {
        if (kind === "skill") {
          setIcon(iconEl, "sparkles");
        } else if (kind === "command") {
          setIcon(iconEl, "terminal");
        } else {
          setIcon(iconEl, kind === "url" ? "link" : "file");
        }
      },
      renderSlashIcon: (iconEl, token) => {
        setIcon(iconEl, token.kind === "skill" ? "sparkles" : "terminal");
      },
    };
  }

  private removeComposerReference(index: number): void {
    if (this.hasPendingSend()) return;
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
    return "";
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

  private attachMessageCopyButton(
    messageEl: HTMLElement,
  ): HTMLButtonElement | undefined {
    return attachMessageCopyButton(messageEl, {
      iconRenderer: (element, icon) => setIcon(element, icon),
      logger: this.logger,
    });
  }

  private messageFor(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function requestHasRawContent(contents: ToolCallContent[]): boolean {
  return contents.length > 0;
}

export interface AttachMessageCopyButtonOptions {
  iconRenderer?: (element: HTMLElement, iconId: string) => void;
  clipboard?: { writeText(text: string): Promise<void> };
  timeoutMs?: number;
  logger?: DebugLogger;
}

/**
 * Attaches a hover-activated copy button to an assistant message bubble.
 * Fails gracefully (no-op) for non-assistant or user messages, or if already attached.
 */
export function attachMessageCopyButton(
  messageEl: HTMLElement,
  options: AttachMessageCopyButtonOptions = {},
): HTMLButtonElement | undefined {
  if (
    !messageEl.classList.contains("is-assistant") ||
    messageEl.classList.contains("is-user")
  ) {
    return undefined;
  }
  if (messageEl.querySelector(".hermesian-message-copy-button")) {
    return undefined;
  }

  const renderIcon = options.iconRenderer ?? ((el, icon) => setIcon(el, icon));
  const clipboard =
    options.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  const timeoutMs = options.timeoutMs ?? 2500;
  const logger = options.logger ?? createDebugLogger(false);

  const button =
    typeof messageEl.createEl === "function"
      ? (messageEl.createEl("button", {
          cls: "hermesian-message-copy-button",
          attr: {
            type: "button",
            "aria-label": "Copy message",
            title: "Copy message",
          },
        }) as HTMLButtonElement)
      : (() => {
          const btn = messageEl.ownerDocument.createElement("button");
          btn.className = "hermesian-message-copy-button";
          btn.type = "button";
          btn.setAttribute("aria-label", "Copy message");
          btn.title = "Copy message";
          messageEl.appendChild(btn);
          return btn;
        })();

  renderIcon(button, "copy");

  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const setCopied = () => {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    button.classList.add("is-copied");
    button.setAttribute("aria-label", "Copied");
    button.title = "Copied";
    renderIcon(button, "check");

    resetTimer = setTimeout(() => {
      button.classList.remove("is-copied");
      button.setAttribute("aria-label", "Copy message");
      button.title = "Copy message";
      renderIcon(button, "copy");
      resetTimer = null;
    }, timeoutMs);
  };

  button.addEventListener("click", async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const contentEl = messageEl.querySelector<HTMLElement>(
      ".hermesian-message-content",
    );
    if (!contentEl) {
      return;
    }
    const text =
      contentEl.innerText?.trim() ? contentEl.innerText : (contentEl.textContent ?? "");
    if (!text) {
      return;
    }

    try {
      if (!clipboard || typeof clipboard.writeText !== "function") {
        throw new Error("Clipboard API not available");
      }
      await clipboard.writeText(text);
      setCopied();
    } catch (error) {
      logger.warn("controller.background.failure", {
        operation: "copy-message",
        ...safeErrorFields(error),
      });
    }
  });

  return button;
}
