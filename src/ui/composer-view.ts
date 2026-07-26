export interface ComposerElements {
  addSelectionButtonEl: HTMLButtonElement;
  composerEl: HTMLTextAreaElement;
  composerHostEl: HTMLElement;
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

  const composerEl = composerHostEl.createEl("textarea", {
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
