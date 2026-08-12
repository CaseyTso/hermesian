/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";

import {
  STEER_RICH_CONTENT_HINT,
  STOPPING_LABEL,
  composerHasRichSteerBlockers,
  composerPrimaryMode,
  composerStopIntent,
  composerSubmitIntent,
  dictationAudioTooShort,
  dictationButtonLabel,
  focusOwnsEscape,
  preferredMediaRecorderMimeType,
  shouldStopOnEscape,
  steerableDraftFactsFromComposer,
} from "../src/composer-actions";
import type { ComposerInlineDraft } from "../src/composer-reference-tokens";

function draft(overrides: Partial<ComposerInlineDraft> = {}): ComposerInlineDraft {
  return { token: null, text: "", references: [], ...overrides };
}

describe("steerableDraftFactsFromComposer", () => {
  it("marks pure non-empty text as steerable facts", () => {
    expect(
      steerableDraftFactsFromComposer({
        draft: draft({ text: " correct course " }),
        hasPendingImages: false,
        hasPendingSelection: false,
      }),
    ).toEqual({
      hasText: true,
      hasPendingImages: false,
      hasPendingSelection: false,
      hasReferenceCapsules: false,
      hasSlashToken: false,
    });
  });

  it("flags rich content blockers", () => {
    const facts = steerableDraftFactsFromComposer({
      draft: draft({
        text: "x",
        token: { kind: "skill", name: "leader" },
        references: [{ kind: "url", value: "https://example.com", start: 0 }],
      }),
      hasPendingImages: true,
      hasPendingSelection: true,
    });
    expect(composerHasRichSteerBlockers(facts)).toBe(true);
    expect(facts.hasSlashToken).toBe(true);
    expect(facts.hasReferenceCapsules).toBe(true);
  });
});

describe("composerPrimaryMode", () => {
  it("shows Send when idle", () => {
    expect(
      composerPrimaryMode({ stopping: false, stopAvailable: false, steerAvailable: false }),
    ).toBe("send");
  });

  it("shows Stop alone while running with an empty draft", () => {
    expect(
      composerPrimaryMode({ stopping: false, stopAvailable: true, steerAvailable: false }),
    ).toBe("stop");
  });

  it("shows Stop + Steer when running with steerable text", () => {
    expect(
      composerPrimaryMode({ stopping: false, stopAvailable: true, steerAvailable: true }),
    ).toBe("stop-steer");
  });

  it("shows Stopping… while stop-and-send is in flight", () => {
    expect(
      composerPrimaryMode({ stopping: true, stopAvailable: true, steerAvailable: true }),
    ).toBe("stopping");
    expect(STOPPING_LABEL).toBe("Stopping…");
  });
});

describe("composerSubmitIntent", () => {
  const pure = {
    hasText: true,
    hasPendingImages: false,
    hasPendingSelection: false,
    hasReferenceCapsules: false,
    hasSlashToken: false,
  } as const;

  it("routes idle Enter to send", () => {
    expect(
      composerSubmitIntent({
        stopAvailable: false,
        steerAvailable: false,
        facts: pure,
        stopping: false,
        sendAvailable: true,
      }),
    ).toEqual({ kind: "send" });
  });

  it("routes running pure-text Enter to steer", () => {
    expect(
      composerSubmitIntent({
        stopAvailable: true,
        steerAvailable: true,
        facts: pure,
        stopping: false,
        sendAvailable: false,
      }),
    ).toEqual({ kind: "steer" });
  });

  it("rejects rich content during an active turn and keeps the draft", () => {
    expect(
      composerSubmitIntent({
        stopAvailable: true,
        steerAvailable: false,
        facts: { ...pure, hasPendingImages: true },
        stopping: false,
        sendAvailable: false,
      }),
    ).toEqual({ kind: "reject-rich", reason: STEER_RICH_CONTENT_HINT });
  });

  it("noops while stopping or with an empty running draft", () => {
    expect(
      composerSubmitIntent({
        stopAvailable: true,
        steerAvailable: false,
        facts: { ...pure, hasText: false },
        stopping: false,
        sendAvailable: false,
      }),
    ).toEqual({ kind: "noop" });
    expect(
      composerSubmitIntent({
        stopAvailable: true,
        steerAvailable: true,
        facts: pure,
        stopping: true,
        sendAvailable: false,
      }),
    ).toEqual({ kind: "noop" });
  });
});

describe("composerStopIntent", () => {
  it("cancels when the composer is empty", () => {
    expect(
      composerStopIntent({ stopAvailable: true, stopping: false, draft: "   " }),
    ).toEqual({ kind: "cancel" });
  });

  it("snapshots non-empty drafts for stop-and-send", () => {
    expect(
      composerStopIntent({
        stopAvailable: true,
        stopping: false,
        draft: "follow up after cancel",
      }),
    ).toEqual({ kind: "stop-and-send", draft: "follow up after cancel" });
  });

  it("noops while already stopping", () => {
    expect(
      composerStopIntent({
        stopAvailable: true,
        stopping: true,
        draft: "ignored",
      }),
    ).toEqual({ kind: "noop" });
  });
});

describe("Esc focus rules", () => {
  it("stops only for non-interactive surfaces during an active turn", () => {
    expect(
      shouldStopOnEscape({
        stopAvailable: true,
        stopping: false,
        focusOwnsEscape: false,
      }),
    ).toBe(true);
    expect(
      shouldStopOnEscape({
        stopAvailable: true,
        stopping: false,
        focusOwnsEscape: true,
      }),
    ).toBe(false);
    expect(
      shouldStopOnEscape({
        stopAvailable: true,
        stopping: true,
        focusOwnsEscape: false,
      }),
    ).toBe(false);
  });

  it("treats inputs, contenteditable, menus, and dialogs as Esc owners", () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    root.appendChild(input);
    expect(focusOwnsEscape(input)).toBe(true);

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    root.appendChild(editable);
    expect(focusOwnsEscape(editable)).toBe(true);

    const menu = document.createElement("div");
    menu.className = "hermesian-slash-menu";
    const option = document.createElement("button");
    menu.appendChild(option);
    root.appendChild(menu);
    expect(focusOwnsEscape(option)).toBe(true);

    const plain = document.createElement("div");
    plain.className = "hermesian-messages";
    root.appendChild(plain);
    expect(focusOwnsEscape(plain)).toBe(false);
  });
});

describe("dictation helpers", () => {
  it("labels microphone phases accessibly", () => {
    expect(dictationButtonLabel("idle")).toBe("Start dictation");
    expect(dictationButtonLabel("listening")).toBe("Stop dictation");
    expect(dictationButtonLabel("transcribing")).toBe("Transcribing…");
  });

  it("rejects empty or tiny recordings before STT", () => {
    expect(dictationAudioTooShort(0)).toBe(true);
    expect(dictationAudioTooShort(32)).toBe(true);
    expect(dictationAudioTooShort(1024)).toBe(false);
  });

  it("picks the first MediaRecorder MIME the browser supports", () => {
    expect(
      preferredMediaRecorderMimeType((mime) => mime === "audio/webm"),
    ).toBe("audio/webm");
    expect(
      preferredMediaRecorderMimeType((mime) => mime === "audio/mp4"),
    ).toBe("audio/mp4");
    expect(preferredMediaRecorderMimeType(() => false)).toBe("");
  });
});
