import type { ComposerSlashToken } from "../slash-menu";
import { visibleSlashTokenLabel } from "../slash-menu";
import {
  referenceTokenDisplayLabel,
  type ReferenceToken,
  type ReferenceTokenKind,
} from "../composer-reference-tokens";
import type { ComposerInlineDraft } from "../composer-reference-tokens";
import {
  handleInlineEditorInput,
  renderInlineDraft,
  type InlineEditorRenderOptions,
} from "../composer-inline-editor";
import {
  STOPPING_LABEL,
  dictationButtonLabel,
  type ComposerPrimaryMode,
  type DictationUiPhase,
} from "../composer-actions";

export interface ComposerElements {
  addSelectionButtonEl: HTMLButtonElement;
  composerEl: HTMLElement;
  composerHostEl: HTMLElement;
  composerInputRowEl: HTMLElement;
  contextProgressEl: HTMLElement;
  contextUsageEl: HTMLElement;
  currentFileBarEl: HTMLButtonElement;
  currentFileLabelEl: HTMLElement;
  dictationButtonEl: HTMLButtonElement;
  fileInputEl: HTMLInputElement;
  filePickerButtonEl: HTMLButtonElement;
  filePickerMenuEl: HTMLElement;
  folderInputEl: HTMLInputElement;
  /** Detaches document-level listeners (outside-click menu close). */
  dispose?(): void;
  hintEl: HTMLElement;
  imageAttachmentBarEl: HTMLElement;
  modelButtonEl: HTMLButtonElement;
  modelLabelEl: HTMLElement;
  reasoningButtonEl: HTMLButtonElement;
  reasoningLabelEl: HTMLElement;
  referenceChipsEl: HTMLElement;
  selectionBarEl: HTMLElement;
  sendButtonEl: HTMLButtonElement;
  slashMenuEl: HTMLElement;
  slashTokenEl: HTMLElement;
  slashTokenIconEl: HTMLElement;
  slashTokenLabelEl: HTMLElement;
  statusEl: HTMLElement;
  steerButtonEl: HTMLButtonElement;
  stopButtonEl: HTMLButtonElement;
}

export interface ComposerState {
  /** Whether the composer editor is disabled (e.g., during initialization). */
  disabled: boolean;
  /** Current draft model (full text + inline reference placements). */
  draft: ComposerInlineDraft;
  /** Dictation microphone phase. */
  dictationPhase?: DictationUiPhase;
  /** Whether dictation can start/stop (composer editable). */
  dictationEnabled?: boolean;
  /** Ephemeral hint/error near the primary actions (steer reject, STT error). */
  hint?: string;
  /** Placeholder shown when the editor is empty. */
  placeholder: string;
  /**
   * Primary action matrix. Prefer this over the legacy stopVisible boolean;
   * when omitted, stopVisible falls back to the pre-steer Send/Stop toggle.
   */
  primaryMode?: ComposerPrimaryMode;
  /** Whether the Send button is enabled. */
  sendEnabled: boolean;
  /** Whether the Steer button is enabled (in-flight steers disable it). */
  steerEnabled?: boolean;
  /** @deprecated Prefer primaryMode. Kept for older call sites/tests. */
  stopVisible: boolean;
  /** Whether Stop is clickable (false while Stopping…). */
  stopEnabled?: boolean;
}

export interface ComposerCallbacks {
  /** Called when the user modifies the draft (model synced from the editor DOM). */
  onDraftChange(draft: ComposerInlineDraft): void;
  /**
   * Fetch the host's CURRENT draft. The editor must never keep a
   * creation-time snapshot: external restores / tab switches replace the
   * host model, and ordinary input has to carry that live token forward.
   */
  getDraft(): ComposerInlineDraft;
  /** Called on Enter (without Shift) or Send / Steer button click. */
  onSend(): void;
  /**
   * Called when the user opens the native file/folder dialog, BEFORE
   * `input.click()` — the host captures the caret while the editor is still
   * focused.
   */
  onFilePickerOpen?(kind: "file" | "folder"): void;
  /** Called on Stop button click. */
  onStop(): void;
  /** Called on Steer button click (running turn, pure-text draft). */
  onSteer?(): void;
  /** Called on microphone button click (start/stop single recording). */
  onDictation?(): void;
  /** Called on paste events (image handling and text pastes). */
  onPaste(event: ClipboardEvent): void;
  /** Keydown forwarded from the editor — host drives slash menu + adapter. */
  onKeydown(event: KeyboardEvent): void;
  /** Copy event forwarded from the editor (capsule-aware clipboard). */
  onCopy?(event: ClipboardEvent): void;
  /** Cut event forwarded from the editor (capsule-aware clipboard). */
  onCut?(event: ClipboardEvent): void;
  /** Called when an inline capsule's remove button is clicked. */
  onReferenceRemove?(index: number): void;
  /** Optional icon renderer (host injects Obsidian's setIcon). */
  renderIcon?(iconEl: HTMLElement, kind: ReferenceTokenKind): void;
}

function resolvePrimaryMode(state: ComposerState): ComposerPrimaryMode {
  if (state.primaryMode) {
    return state.primaryMode;
  }
  return state.stopVisible ? "stop" : "send";
}

export function createComposerView(
  parent: HTMLElement,
  state: ComposerState,
  callbacks: ComposerCallbacks,
): ComposerElements {
  const composerHostEl = parent.createDiv({ cls: "hermesian-composer" });
  const composerContexts = composerHostEl.createDiv({ cls: "hermesian-composer-contexts" });

  const currentFileBarEl = composerContexts.createEl("button", {
    attr: { type: "button" },
    cls: "hermesian-current-file",
  }) as HTMLButtonElement;
  const currentFileIcon = currentFileBarEl.createSpan({
    cls: "hermesian-current-file-icon",
  });
  currentFileIcon.empty();
  const currentFileLabelEl = currentFileBarEl.createSpan({
    cls: "hermesian-current-file-label",
  });

  const selectionBarEl = composerContexts.createDiv({ cls: "hermesian-selection-bar" });
  selectionBarEl.hide();
  const imageAttachmentBarEl = composerContexts.createDiv({
    cls: "hermesian-image-attachment-bar",
  });
  imageAttachmentBarEl.hide();

  const composerInputRowEl = composerHostEl.createDiv({
    cls: "hermesian-composer-input-row",
  });

  const slashTokenEl = composerInputRowEl.createSpan({
    attr: {
      "aria-hidden": "true",
      role: "status",
    },
    cls: "hermesian-slash-token",
  });
  slashTokenEl.hide();
  const slashTokenIconEl = slashTokenEl.createSpan({
    cls: "hermesian-slash-token-icon",
  });
  slashTokenIconEl.empty();
  const slashTokenLabelEl = slashTokenEl.createSpan({
    cls: "hermesian-slash-token-label",
  });

  const referenceChipsEl = composerInputRowEl.createDiv({
    cls: "hermesian-composer-refs",
  });
  referenceChipsEl.hide();

  const composerEl = composerInputRowEl.createEl("div", {
    attr: {
      "aria-autocomplete": "list",
      "aria-controls": "hermesian-slash-menu",
      "aria-expanded": "false",
      "aria-label": "Message Hermes",
      "aria-multiline": "true",
      "data-placeholder": state.placeholder,
      role: "textbox",
    },
    cls: "hermesian-input",
  }) as HTMLElement;
  composerEl.setAttribute("contenteditable", state.disabled ? "false" : "true");

  const renderOptions = (): InlineEditorRenderOptions => ({
    onRemoveReference: callbacks.onReferenceRemove,
    renderIcon: callbacks.renderIcon,
  });
  renderInlineDraft(composerEl, state.draft, renderOptions());

  const slashMenuEl = composerHostEl.createDiv({
    attr: {
      "aria-label": "Hermes slash commands and skills",
      id: "hermesian-slash-menu",
      role: "listbox",
    },
    cls: "hermesian-slash-menu",
  });
  slashMenuEl.hide();

  const composerFooter = composerHostEl.createDiv({ cls: "hermesian-composer-footer" });
  const controlRow = composerFooter.createDiv({ cls: "hermesian-control-row" });

  const filePickerButtonEl = controlRow.createEl("button", {
    attr: {
      "aria-label": "Attach file or folder",
      title: "Attach file or folder",
      type: "button",
    },
    cls: "clickable-icon hermesian-file-picker",
  });
  const filePickerIcon = filePickerButtonEl.createSpan();
  filePickerIcon.empty();

  // Hidden native inputs: the host wires `change` and reads File.path.
  // Single-select file input (no `multiple`), folder input with webkitdirectory.
  const fileInputEl = composerHostEl.createEl("input", {
    attr: {
      "aria-hidden": "true",
      tabindex: "-1",
      type: "file",
    },
  }) as HTMLInputElement;
  fileInputEl.style.display = "none";

  const folderInputEl = composerHostEl.createEl("input", {
    attr: {
      "aria-hidden": "true",
      tabindex: "-1",
      type: "file",
      webkitdirectory: "",
    },
  }) as HTMLInputElement;
  folderInputEl.style.display = "none";

  // Dropdown menu: plain div (no Obsidian Menu) toggled by the button; menu
  // items trigger the matching hidden input and close; outside clicks close.
  const filePickerMenuEl = controlRow.createDiv({ cls: "hermesian-file-picker-menu" });
  filePickerMenuEl.hide();
  const pickFileOptionEl = filePickerMenuEl.createEl("button", {
    attr: { type: "button" },
    cls: "hermesian-file-picker-option",
    text: "Select file…",
  });
  const pickFolderOptionEl = filePickerMenuEl.createEl("button", {
    attr: { type: "button" },
    cls: "hermesian-file-picker-option",
    text: "Select folder…",
  });
  pickFileOptionEl.addEventListener("click", () => {
    callbacks.onFilePickerOpen?.("file");
    fileInputEl.click();
    filePickerMenuEl.hide();
  });
  pickFolderOptionEl.addEventListener("click", () => {
    callbacks.onFilePickerOpen?.("folder");
    folderInputEl.click();
    filePickerMenuEl.hide();
  });
  filePickerButtonEl.addEventListener("click", () => {
    if (filePickerMenuEl.style.display === "none") {
      filePickerMenuEl.show();
    } else {
      filePickerMenuEl.hide();
    }
  });
  const outsideClickHandler = (event: MouseEvent): void => {
    if (
      !filePickerButtonEl.contains(event.target as Node) &&
      !filePickerMenuEl.contains(event.target as Node)
    ) {
      filePickerMenuEl.hide();
    }
  };
  filePickerMenuEl.ownerDocument.addEventListener("click", outsideClickHandler);

  const modelButtonEl = controlRow.createEl("button", {
    attr: { "aria-label": "Select Hermes model" },
    cls: "hermesian-model-button",
  });
  const modelIcon = modelButtonEl.createSpan({ cls: "hermesian-model-icon" });
  modelIcon.empty();
  const modelLabelEl = modelButtonEl.createSpan({
    text: "Loading model…",
    cls: "hermesian-model-label",
  });
  const chevron = modelButtonEl.createSpan({ cls: "hermesian-model-chevron" });
  chevron.empty();

  const reasoningButtonEl = controlRow.createEl("button", {
    attr: { "aria-label": "Adjust Hermes thinking depth" },
    cls: "hermesian-reasoning-button",
  });
  const reasoningIcon = reasoningButtonEl.createSpan({ cls: "hermesian-reasoning-icon" });
  reasoningIcon.empty();
  const reasoningLabelEl = reasoningButtonEl.createSpan({ cls: "hermesian-reasoning-label" });

  const addSelectionButtonEl = controlRow.createEl("button", {
    attr: {
      "aria-label": "Add selection",
      title: "Add selection",
      type: "button",
    },
    cls: "clickable-icon hermesian-add-selection",
  });
  const addSelectionIcon = addSelectionButtonEl.createSpan();
  addSelectionIcon.empty();

  const dictationButtonEl = controlRow.createEl("button", {
    attr: {
      "aria-label": dictationButtonLabel("idle"),
      title: dictationButtonLabel("idle"),
      type: "button",
    },
    cls: "clickable-icon hermesian-dictation",
  });
  const dictationIcon = dictationButtonEl.createSpan();
  dictationIcon.empty();

  const sendButtonEl = controlRow.createEl("button", {
    attr: {
      "aria-label": "Send message",
      title: "Send message",
      type: "button",
    },
    cls: "clickable-icon hermesian-primary-action is-send",
  });
  const sendIcon = sendButtonEl.createSpan();
  sendIcon.empty();

  const steerButtonEl = controlRow.createEl("button", {
    attr: {
      "aria-label": "Steer active turn",
      title: "Steer active turn",
      type: "button",
    },
    cls: "clickable-icon hermesian-primary-action is-steer",
  });
  const steerIcon = steerButtonEl.createSpan();
  steerIcon.empty();

  const stopButtonEl = controlRow.createEl("button", {
    attr: {
      "aria-label": "Stop response",
      title: "Stop response",
      type: "button",
    },
    cls: "clickable-icon hermesian-primary-action is-stop",
  });
  const stopIcon = stopButtonEl.createSpan();
  stopIcon.empty();

  const statusEl = composerFooter.createDiv({
    attr: { "aria-live": "polite", role: "status" },
    cls: "hermesian-composer-status",
  });
  statusEl.hide();

  const hintEl = composerFooter.createDiv({
    attr: { "aria-live": "polite", role: "status" },
    cls: "hermesian-composer-hint",
  });
  hintEl.hide();

  // Apply initial visibility
  applyComposerState(
    {
      composerEl,
      dictationButtonEl,
      filePickerButtonEl,
      filePickerMenuEl,
      hintEl,
      sendButtonEl,
      statusEl,
      steerButtonEl,
      stopButtonEl,
    },
    state,
  );

  // --- Event wiring ---
  composerEl.addEventListener("input", () => {
    // Always read the host's LIVE draft — never a creation-time snapshot —
    // so tokens applied by external restores / tab switches survive typing.
    const updated = handleInlineEditorInput(composerEl, callbacks.getDraft());
    callbacks.onDraftChange(updated);
  });

  composerEl.addEventListener("paste", (event) => {
    callbacks.onPaste(event);
  });

  composerEl.addEventListener("keydown", (event) => {
    callbacks.onKeydown(event);
  });

  composerEl.addEventListener("copy", (event) => {
    callbacks.onCopy?.(event);
  });

  composerEl.addEventListener("cut", (event) => {
    callbacks.onCut?.(event);
  });

  composerEl.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!slashMenuEl.contains(composerHostEl.ownerDocument.activeElement)) {
        slashMenuEl.hide();
      }
    }, 0);
  });

  sendButtonEl.addEventListener("click", () => {
    if (!sendButtonEl.disabled && sendButtonEl.style.display !== "none") {
      callbacks.onSend();
    }
  });

  steerButtonEl.addEventListener("click", () => {
    if (!steerButtonEl.disabled && steerButtonEl.style.display !== "none") {
      callbacks.onSteer?.();
    }
  });

  stopButtonEl.addEventListener("click", () => {
    if (!stopButtonEl.disabled && stopButtonEl.style.display !== "none") {
      callbacks.onStop();
    }
  });

  dictationButtonEl.addEventListener("click", () => {
    if (!dictationButtonEl.disabled) {
      callbacks.onDictation?.();
    }
  });

  const context = composerFooter.createDiv({ cls: "hermesian-context" });
  const contextUsageEl = context.createDiv({
    text: "Context —",
    cls: "hermesian-context-label",
  });
  const contextTrack = context.createDiv({ cls: "hermesian-context-track" });
  const contextProgressEl = contextTrack.createDiv({
    cls: "hermesian-context-progress",
  });

  return {
    addSelectionButtonEl,
    composerEl,
    composerHostEl,
    composerInputRowEl,
    contextProgressEl,
    contextUsageEl,
    currentFileBarEl,
    currentFileLabelEl,
    dictationButtonEl,
    dispose: () => {
      filePickerMenuEl.ownerDocument.removeEventListener("click", outsideClickHandler);
    },
    fileInputEl,
    filePickerButtonEl,
    filePickerMenuEl,
    folderInputEl,
    hintEl,
    imageAttachmentBarEl,
    modelButtonEl,
    modelLabelEl,
    reasoningButtonEl,
    reasoningLabelEl,
    referenceChipsEl,
    selectionBarEl,
    sendButtonEl,
    slashMenuEl,
    slashTokenEl,
    slashTokenIconEl,
    slashTokenLabelEl,
    statusEl,
    steerButtonEl,
    stopButtonEl,
  };
}

export function applyComposerState(
  elements: {
    composerEl: HTMLElement;
    sendButtonEl: HTMLButtonElement;
    stopButtonEl: HTMLButtonElement;
    steerButtonEl?: HTMLButtonElement;
    dictationButtonEl?: HTMLButtonElement;
    filePickerButtonEl?: HTMLButtonElement;
    filePickerMenuEl?: HTMLElement;
    statusEl?: HTMLElement;
    hintEl?: HTMLElement;
  },
  state: ComposerState,
): void {
  elements.composerEl.contentEditable = state.disabled ? "false" : "true";
  elements.composerEl.setAttribute(
    "data-placeholder",
    state.placeholder || elements.composerEl.getAttribute("data-placeholder") || "",
  );

  const mode = resolvePrimaryMode(state);
  const stopEnabled = state.stopEnabled !== false && mode !== "stopping";
  const steerEnabled = state.steerEnabled !== false && mode === "stop-steer";
  const dictationPhase = state.dictationPhase ?? "idle";
  const dictationEnabled =
    state.dictationEnabled !== false && !state.disabled && dictationPhase !== "transcribing";

  elements.sendButtonEl.disabled = !state.sendEnabled || mode !== "send";

  // Visibility matrix
  const showSend = mode === "send";
  const showStop = mode === "stop" || mode === "stop-steer" || mode === "stopping";
  const showSteer = mode === "stop-steer";

  if (showSend) {
    elements.sendButtonEl.show();
  } else {
    elements.sendButtonEl.hide();
  }
  if (showStop) {
    elements.stopButtonEl.show();
  } else {
    elements.stopButtonEl.hide();
  }
  if (elements.steerButtonEl) {
    if (showSteer) {
      elements.steerButtonEl.show();
    } else {
      elements.steerButtonEl.hide();
    }
    elements.steerButtonEl.disabled = !steerEnabled;
  }

  elements.stopButtonEl.disabled = !stopEnabled;
  if (mode === "stopping") {
    elements.stopButtonEl.setAttribute("aria-label", STOPPING_LABEL);
    elements.stopButtonEl.setAttribute("title", STOPPING_LABEL);
    elements.stopButtonEl.classList.add("is-stopping");
  } else {
    elements.stopButtonEl.setAttribute("aria-label", "Stop response");
    elements.stopButtonEl.setAttribute("title", "Stop response");
    elements.stopButtonEl.classList.remove("is-stopping");
  }

  if (elements.dictationButtonEl) {
    const label = dictationButtonLabel(dictationPhase);
    elements.dictationButtonEl.disabled = !dictationEnabled;
    elements.dictationButtonEl.setAttribute("aria-label", label);
    elements.dictationButtonEl.setAttribute("title", label);
    elements.dictationButtonEl.setAttribute(
      "aria-pressed",
      dictationPhase === "listening" ? "true" : "false",
    );
    elements.dictationButtonEl.classList.toggle(
      "is-listening",
      dictationPhase === "listening",
    );
    elements.dictationButtonEl.classList.toggle(
      "is-transcribing",
      dictationPhase === "transcribing",
    );
  }

  if (elements.filePickerButtonEl) {
    elements.filePickerButtonEl.disabled = state.disabled;
  }

  if (elements.filePickerMenuEl) {
    if (state.disabled) {
      elements.filePickerMenuEl.hide();
    }
    const options = elements.filePickerMenuEl.querySelectorAll<HTMLButtonElement>(
      ".hermesian-file-picker-option",
    );
    for (const option of Array.from(options)) {
      option.disabled = state.disabled;
    }
  }

  if (elements.statusEl) {
    if (mode === "stopping") {
      elements.statusEl.textContent = STOPPING_LABEL;
      elements.statusEl.show();
      elements.statusEl.classList.add("is-stopping");
    } else if (dictationPhase === "listening") {
      elements.statusEl.textContent = "Listening…";
      elements.statusEl.show();
      elements.statusEl.classList.remove("is-stopping");
      elements.statusEl.classList.add("is-listening");
    } else if (dictationPhase === "transcribing") {
      elements.statusEl.textContent = "Transcribing…";
      elements.statusEl.show();
      elements.statusEl.classList.remove("is-stopping", "is-listening");
    } else {
      elements.statusEl.textContent = "";
      elements.statusEl.hide();
      elements.statusEl.classList.remove("is-stopping", "is-listening");
    }
  }

  if (elements.hintEl) {
    const hint = state.hint?.trim() ?? "";
    if (hint) {
      elements.hintEl.textContent = hint;
      elements.hintEl.show();
      elements.hintEl.classList.toggle("is-error", /fail|error|could not|denied/i.test(hint));
    } else {
      elements.hintEl.textContent = "";
      elements.hintEl.hide();
      elements.hintEl.classList.remove("is-error");
    }
  }

  // Only auto-focus when returning to an editable send surface — never steal
  // focus while Stopping or while the user is reading a permission card.
  if (showSend && !state.disabled && mode === "send") {
    // Host decides focus; do not force here on every paint.
  }
}

/**
 * Re-render the editor when the draft model changes (structural edits are
 * applied by the adapter itself; this covers restore/clear paths where the
 * host supplies a brand-new model reference).
 */
export function applyComposerDraft(
  elements: Pick<ComposerElements, "composerEl">,
  draft: ComposerInlineDraft,
  callbacks: Pick<ComposerCallbacks, "onReferenceRemove" | "renderIcon">,
): void {
  renderInlineDraft(elements.composerEl, draft, {
    onRemoveReference: callbacks.onReferenceRemove,
    renderIcon: callbacks.renderIcon,
  });
}
export interface ComposerReferenceElements {
  referenceChipsEl: HTMLElement;
}

export interface ComposerReferenceCallbacks {
  /** Called when a chip's remove button is clicked. */
  onRemoveReference(index: number): void;
  /** Optional icon renderer (host injects Obsidian's setIcon). */
  renderIcon?(iconEl: HTMLElement, kind: ReferenceTokenKind): void;
}

/**
 * Render the ordered reference chips (whole-paste URLs / absolute paths)
 * as neutral filled capsules before the textarea. Multiple chips wrap on
 * narrow sidebars; each chip shows a compact display label (URL host /
 * path basename) with the full value in `title` and an accessible remove
 * name. Never matches the slash-token chrome (accent-colored capsule /
 * blue inline).
 */
export function applyComposerReferences(
  elements: ComposerReferenceElements,
  references: ReferenceToken[],
  callbacks: ComposerReferenceCallbacks,
): void {
  const container = elements.referenceChipsEl;
  container.empty();
  if (references.length === 0) {
    container.hide();
    return;
  }
  container.show();
  references.forEach((reference, index) => {
    const chip = container.createEl("button", {
      attr: {
        "aria-label": `Remove reference ${reference.kind === "url" ? "URL" : "path"} ${reference.value}`,
        title: reference.value,
        type: "button",
      },
      cls: `hermesian-ref-token is-${reference.kind}`,
    });
    const icon = chip.createSpan({ cls: "hermesian-ref-token-icon" });
    callbacks.renderIcon?.(icon, reference.kind);
    chip.createSpan({
      cls: "hermesian-ref-token-label",
      text: referenceTokenDisplayLabel(reference),
    });
    chip.addEventListener("click", () => {
      callbacks.onRemoveReference(index);
    });
  });
}
export function applyComposerSlashToken(
  elements: Pick<
    ComposerElements,
    "slashTokenEl" | "slashTokenIconEl" | "slashTokenLabelEl" | "composerEl"
  >,
  token: ComposerSlashToken | null,
): void {
  if (!token) {
    elements.slashTokenEl.hide();
    elements.slashTokenEl.classList.remove("is-skill", "is-command", "is-capsule");
    elements.slashTokenEl.removeAttribute("aria-label");
    elements.slashTokenEl.setAttribute("aria-hidden", "true");
    elements.slashTokenLabelEl.textContent = "";
    elements.slashTokenIconEl.empty();
    return;
  }

  const label = visibleSlashTokenLabel(token);
  const isSkill = token.kind === "skill";
  elements.slashTokenEl.classList.toggle("is-skill", isSkill);
  elements.slashTokenEl.classList.toggle("is-command", !isSkill);
  elements.slashTokenEl.classList.toggle("is-capsule", isSkill);
  elements.slashTokenEl.setAttribute(
    "aria-label",
    isSkill ? `Skill ${label}` : `Command ${label}`,
  );
  elements.slashTokenEl.setAttribute("aria-hidden", "false");
  elements.slashTokenLabelEl.textContent = label;
  elements.slashTokenEl.show();
}
