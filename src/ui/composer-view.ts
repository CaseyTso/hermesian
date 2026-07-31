import type { ComposerSlashToken } from "../slash-menu";
import { visibleSlashTokenLabel } from "../slash-menu";

export interface ComposerElements {
  addSelectionButtonEl: HTMLButtonElement;
  composerEl: HTMLTextAreaElement;
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
  selectionBarEl: HTMLElement;
  sendButtonEl: HTMLButtonElement;
  slashMenuEl: HTMLElement;
  slashTokenEl: HTMLElement;
  slashTokenIconEl: HTMLElement;
  slashTokenLabelEl: HTMLElement;
  stopButtonEl: HTMLButtonElement;
}

export interface ComposerState {
  /** Whether the composer textarea is disabled (e.g., during initialization). */
  disabled: boolean;
  /** Current draft text. */
  draft: string;
  /** Placeholder shown when the textarea is empty. */
  placeholder: string;
  /** Whether the Send button is enabled. */
  sendEnabled: boolean;
  /** Whether the Stop button should be shown instead of Send. */
  stopVisible: boolean;
}

export interface ComposerCallbacks {
  /** Called when the user modifies the draft text. */
  onDraftChange(draft: string): void;
  /** Called on Enter (without Shift) or Send button click. */
  onSend(): void;
  /** Called on Stop button click. */
  onStop(): void;
  /** Called on paste events for image handling. */
  onPaste(event: ClipboardEvent): void;
  /**
   * Optional: empty-task Backspace while a slash token is visible.
   * Parent should clear the atomic token and restore plain input.
   */
  onSlashTokenClear?(): void;
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

  const composerEl = composerInputRowEl.createEl("textarea", {
    attr: {
      "aria-autocomplete": "list",
      "aria-controls": "hermesian-slash-menu",
      "aria-expanded": "false",
      "aria-label": "Message Hermes",
      placeholder: state.placeholder,
      role: "combobox",
      rows: "3",
    },
    cls: "hermesian-input",
  }) as HTMLTextAreaElement;

  composerEl.value = state.draft;
  composerEl.disabled = state.disabled;

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
    callbacks.onDraftChange(composerEl.value);
  });

  composerEl.addEventListener("paste", (event) => {
    callbacks.onPaste(event);
  });

  composerEl.addEventListener("keydown", (event) => {
    if (event.key !== "Backspace" || event.isComposing) {
      return;
    }
    if (!callbacks.onSlashTokenClear) {
      return;
    }
    if (slashTokenEl.style.display === "none") {
      return;
    }
    const start = composerEl.selectionStart ?? 0;
    const end = composerEl.selectionEnd ?? 0;
    if (start !== 0 || end !== 0) {
      return;
    }
    if (composerEl.value.length > 0) {
      return;
    }
    event.preventDefault();
    callbacks.onSlashTokenClear();
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
  elements.composerEl.disabled = state.disabled;
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
 * Show or hide the atomic slash token beside the textarea.
 * Skill tokens use a capsule chrome; native commands stay inline blue text.
 */
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
