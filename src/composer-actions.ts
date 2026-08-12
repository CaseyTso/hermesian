import type { ComposerInlineDraft } from "./composer-reference-tokens";
import {
  isSteerableDraft,
  type SteerableDraftFacts,
} from "./conversation-runtime";

/**
 * Pure composer action routing for Active Turn Steer / Stop / Stop-and-send.
 * UI hosts feed live draft + runtime flags; this module never talks to ACP.
 */

export type ComposerPrimaryMode = "send" | "stop" | "stop-steer" | "stopping";

export type ComposerSubmitIntent =
  | { kind: "send" }
  | { kind: "steer" }
  | { kind: "reject-rich"; reason: string }
  | { kind: "noop" };

export type ComposerStopIntent =
  | { kind: "cancel" }
  | { kind: "stop-and-send"; draft: string }
  | { kind: "noop" };

export const STEER_RICH_CONTENT_HINT =
  "Steer only accepts plain text. Remove images, selection, slash commands, or reference capsules — the draft was kept.";

export const STOPPING_LABEL = "Stopping…";

/** Build steerable-draft facts from the live composer + pending context bars. */
export function steerableDraftFactsFromComposer(input: {
  draft: ComposerInlineDraft;
  hasPendingImages: boolean;
  hasPendingSelection: boolean;
}): SteerableDraftFacts {
  return {
    hasText: input.draft.text.trim().length > 0,
    hasPendingImages: input.hasPendingImages,
    hasPendingSelection: input.hasPendingSelection,
    hasReferenceCapsules: input.draft.references.length > 0,
    hasSlashToken: input.draft.token !== null,
  };
}

export function composerHasRichSteerBlockers(facts: SteerableDraftFacts): boolean {
  return (
    facts.hasPendingImages === true ||
    facts.hasPendingSelection === true ||
    facts.hasReferenceCapsules === true ||
    facts.hasSlashToken === true
  );
}

/**
 * Primary-action visibility matrix:
 * - idle → Send
 * - running + empty → Stop
 * - running + steerable text → Stop + Steer
 * - stopping → Stopping… (Stop shown, disabled)
 */
export function composerPrimaryMode(input: {
  stopping: boolean;
  stopAvailable: boolean;
  steerAvailable: boolean;
}): ComposerPrimaryMode {
  if (input.stopping) {
    return "stopping";
  }
  if (input.stopAvailable && input.steerAvailable) {
    return "stop-steer";
  }
  if (input.stopAvailable) {
    return "stop";
  }
  return "send";
}

/**
 * Enter / primary-submit routing while the composer is focused.
 * Running turns never fall through to a normal send from this path.
 */
export function composerSubmitIntent(input: {
  stopAvailable: boolean;
  steerAvailable: boolean;
  facts: SteerableDraftFacts;
  stopping: boolean;
  sendAvailable: boolean;
}): ComposerSubmitIntent {
  if (input.stopping) {
    return { kind: "noop" };
  }
  if (input.stopAvailable) {
    if (input.steerAvailable || isSteerableDraft(input.facts)) {
      return { kind: "steer" };
    }
    if (composerHasRichSteerBlockers(input.facts) && input.facts.hasText === true) {
      return { kind: "reject-rich", reason: STEER_RICH_CONTENT_HINT };
    }
    return { kind: "noop" };
  }
  if (input.sendAvailable) {
    return { kind: "send" };
  }
  return { kind: "noop" };
}

/**
 * Stop click routing. Non-empty pure text (or any non-empty draft string)
 * becomes a stop-and-send snapshot; empty composer is a plain cancel.
 */
export function composerStopIntent(input: {
  stopAvailable: boolean;
  stopping: boolean;
  /** Canonical serialized draft captured at the Stop click. */
  draft: string;
}): ComposerStopIntent {
  if (input.stopping || !input.stopAvailable) {
    return { kind: "noop" };
  }
  const trimmed = input.draft.trim();
  if (trimmed.length > 0) {
    return { kind: "stop-and-send", draft: input.draft };
  }
  return { kind: "cancel" };
}

/** Whether Esc should cancel the active turn for the current focus target. */
export function shouldStopOnEscape(input: {
  stopAvailable: boolean;
  stopping: boolean;
  /** True when focus is inside an interactive control that owns Esc locally. */
  focusOwnsEscape: boolean;
}): boolean {
  return input.stopAvailable && !input.stopping && !input.focusOwnsEscape;
}

/**
 * Interactive targets that must keep Esc for local UI (menus, editors,
 * dialogs) instead of cancelling the Active Turn.
 */
export function focusOwnsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='listbox'], [role='menu'], [role='dialog'], [role='alertdialog'], .modal, .prompt, .menu, .suggestion-container, .hermesian-slash-menu, .hermesian-model-picker, .hermesian-reasoning-picker, .hermesian-permission, .hermesian-clarify",
    )
  ) {
    return true;
  }
  return false;
}

/** Minimum recorded audio size (bytes) before we bother calling STT. */
export const MIN_DICTATION_AUDIO_BYTES = 256;

export type DictationUiPhase = "idle" | "listening" | "transcribing";

export function dictationButtonLabel(phase: DictationUiPhase): string {
  switch (phase) {
    case "listening":
      return "Stop dictation";
    case "transcribing":
      return "Transcribing…";
    default:
      return "Start dictation";
  }
}

export function preferredMediaRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(mimeType),
): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

export function dictationAudioTooShort(byteLength: number): boolean {
  return byteLength < MIN_DICTATION_AUDIO_BYTES;
}
