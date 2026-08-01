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

export interface ComposerElements {
  addSelectionButtonEl: HTMLButtonElement;
  composerEl: HTMLElement;
  composerHostEl: HTMLElement;
  composerInputRowEl: HTMLElement;
  contextProgressEl: HTMLElement;
  contextUsageEl: HTMLElement;
  currentFileBarEl: HTMLButtonElement;
  currentFileLabelEl: HTMLElement;
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
  stopButtonEl: HTMLButtonElement;
}

export interface ComposerState {
  /** Whether the composer editor is disabled (e.g., during initialization). */
  disabled: boolean;
  /** Current draft model (full text + inline reference placements). */
  draft: ComposerInlineDraft;
  /** Placeholder shown when the editor is empty. */
  placeholder: string;
  /** Whether the Send button is enabled. */
  sendEnabled: boolean;
  /** Whether the Stop button should be shown instead of Send. */
  stopVisible: boolean;
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
  /** Called on Enter (without Shift) or Send button click. */
  onSend(): void;
  /** Called on Stop button click. */
  onStop(): void;
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

  // Apply initial visibility
  applyComposerState({ sendButtonEl, stopButtonEl, composerEl }, state);

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
    if (state.sendEnabled) {
      callbacks.onSend();
    }
  });

  stopButtonEl.addEventListener("click", () => {
    callbacks.onStop();
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
    stopButtonEl,
  };
}

export function applyComposerState(
  elements: Pick<ComposerElements, "composerEl" | "sendButtonEl" | "stopButtonEl">,
  state: ComposerState,
): void {
  elements.composerEl.contentEditable = state.disabled ? "false" : "true";
  elements.sendButtonEl.disabled = !state.sendEnabled;

  if (state.stopVisible) {
    elements.sendButtonEl.hide();
    elements.stopButtonEl.show();
  } else {
    elements.stopButtonEl.hide();
    elements.sendButtonEl.show();
    if (!state.disabled) {
      elements.composerEl.focus();
    }
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
