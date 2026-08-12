/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyComposerDraft,
  applyComposerReferences,
  applyComposerSlashToken,
  applyComposerState,
  createComposerView,
  type ComposerCallbacks,
  type ComposerState,
} from "../../src/ui/composer-view";
import type { ComposerInlineDraft } from "../../src/composer-reference-tokens";
import {
  restoreComposerInlineDraft,
  serializeComposerInlineDraft,
} from "../../src/composer-reference-tokens";
import {
  handleInlineEditorKeydown,
  readInlineDraftFromDom,
} from "../../src/composer-inline-editor";
import {
  composerSlashTokenFromMenuItem,
  type ComposerSlashToken,
  type SlashMenuItem,
} from "../../src/slash-menu";

// Minimal mock of Obsidian's HTMLElement extensions used by composer-view.ts.
// The extracted function only calls createDiv, createEl, createSpan, empty,
// setAttr, addEventListener, querySelector, hide, and show.
(HTMLElement.prototype as any).setAttr = function (name: string, value: string) {
  this.setAttribute(name, value);
};
(HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
  const el: any = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text !== undefined) el.textContent = String(options.text);
  if (options.attr) {
    for (const [key, val] of Object.entries(options.attr)) {
      el.setAttribute(key, String(val));
    }
  }
  this.appendChild(el);
  return el;
};
(HTMLElement.prototype as any).empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
};
(HTMLElement.prototype as any).createDiv = function (options: any = {}) {
  return (this as any).createEl("div", options);
};
(HTMLElement.prototype as any).createSpan = function (options: any = {}) {
  return (this as any).createEl("span", options);
};
(HTMLElement.prototype as any).hide = function () {
  (this as HTMLElement).style.display = "none";
};
(HTMLElement.prototype as any).show = function () {
  (this as HTMLElement).style.display = "";
};

function emptyDraft(): ComposerInlineDraft {
  return { token: null, text: "", references: [] };
}

function draft(overrides: Partial<ComposerInlineDraft> = {}): ComposerInlineDraft {
  return { ...emptyDraft(), ...overrides };
}

function defaultState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    disabled: false,
    draft: emptyDraft(),
    placeholder: "Ask Hermes…",
    sendEnabled: true,
    stopVisible: false,
    ...overrides,
  };
}

function setup(
  state?: Partial<ComposerState>,
  callbacksOverrides: Partial<ComposerCallbacks> = {},
) {
  const parent = document.createElement("div");
  // The host keeps ONE live draft model; the editor reads it back through
  // getDraft() on every input (mirrors HermesianSidebarView.composerDraft).
  let hostDraft: ComposerInlineDraft = state?.draft ?? emptyDraft();
  const onDraftChange = vi.fn((draft: ComposerInlineDraft) => {
    hostDraft = draft;
  });
  const callbacks: ComposerCallbacks = {
    getDraft: () => hostDraft,
    onDraftChange,
    onPaste: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onSteer: vi.fn(),
    onDictation: vi.fn(),
    onKeydown: vi.fn(),
    onCopy: vi.fn(),
    onCut: vi.fn(),
    onReferenceRemove: vi.fn(),
    renderIcon: vi.fn(),
    ...callbacksOverrides,
  };
  const elements = createComposerView(parent, defaultState(state), callbacks);
  return {
    parent,
    elements,
    // onReferenceRemove is always provided here; surface it as a concrete
    // function (same spy instance) so legacy chip tests can pass it to
    // required callbacks.
    callbacks: {
      ...callbacks,
      onReferenceRemove: callbacks.onReferenceRemove as (index: number) => void,
    },
    hostDraft: () => hostDraft,
  };
}

describe("createComposerView", () => {
  it("renders a contenteditable editor with the initial draft and placeholder", () => {
    const { elements } = setup({
      draft: draft({ text: "hello" }),
      placeholder: "Write here…",
    });
    expect(elements.composerEl.tagName).toBe("DIV");
    expect(elements.composerEl.getAttribute("contenteditable")).toBe("true");
    expect(elements.composerEl.textContent).toBe("hello");
    expect(elements.composerEl.getAttribute("data-placeholder")).toBe("Write here…");
  });

  it("disables the editor when state.disabled is true", () => {
    const { elements } = setup({ disabled: true });
    expect(elements.composerEl.contentEditable).toBe("false");
  });

  it("keeps the composer accessible with combobox/textbox semantics", () => {
    const { elements } = setup();
    expect(elements.composerEl.getAttribute("aria-label")).toBe("Message Hermes");
    expect(elements.composerEl.getAttribute("role")).toBe("textbox");
    expect(elements.composerEl.getAttribute("aria-multiline")).toBe("true");
    expect(elements.composerEl.getAttribute("aria-controls")).toBe(
      "hermesian-slash-menu",
    );
    expect(elements.composerEl.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the Send button and hides Stop when stopVisible is false", () => {
    const { elements } = setup({ stopVisible: false });
    expect(elements.sendButtonEl.style.display).not.toBe("none");
    expect(elements.stopButtonEl.style.display).toBe("none");
  });

  it("hides Send and shows Stop when stopVisible is true", () => {
    const { elements } = setup({ stopVisible: true });
    expect(elements.sendButtonEl.style.display).toBe("none");
    expect(elements.stopButtonEl.style.display).not.toBe("none");
  });

  it("includes a file picker button placed before the model button", () => {
    const { elements } = setup();
    expect(elements.filePickerButtonEl).toBeTruthy();
    expect(elements.filePickerButtonEl.classList.contains("hermesian-file-picker")).toBe(
      true,
    );
    expect(elements.filePickerButtonEl.getAttribute("aria-label")).toBe(
      "Attach file or folder",
    );
    const row = elements.modelButtonEl.parentElement!;
    const children = Array.from(row.children);
    expect(children.indexOf(elements.filePickerButtonEl)).toBeLessThan(
      children.indexOf(elements.modelButtonEl),
    );
  });

  it("exposes hidden single-select file and folder inputs", () => {
    const { elements } = setup();
    expect(elements.fileInputEl.type).toBe("file");
    expect(elements.fileInputEl.style.display).toBe("none");
    expect(elements.fileInputEl.hasAttribute("multiple")).toBe(false);
    expect(elements.folderInputEl.type).toBe("file");
    expect(elements.folderInputEl.getAttribute("webkitdirectory")).toBe("");
    expect(elements.folderInputEl.hasAttribute("multiple")).toBe(false);
    expect(elements.folderInputEl.style.display).toBe("none");
  });

  it("toggles a dropdown menu with 选择文件… and 选择文件夹… options", () => {
    const { elements } = setup();
    expect(elements.filePickerMenuEl.style.display).toBe("none");
    elements.filePickerButtonEl.click();
    expect(elements.filePickerMenuEl.style.display).not.toBe("none");
    const options = elements.filePickerMenuEl.querySelectorAll(
      ".hermesian-file-picker-option",
    );
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toBe("选择文件…");
    expect(options[1]!.textContent).toBe("选择文件夹…");
    // Toggling the button again closes the menu.
    elements.filePickerButtonEl.click();
    expect(elements.filePickerMenuEl.style.display).toBe("none");
  });

  it("triggers the file input from the 选择文件… option and hides the menu", () => {
    const { elements } = setup();
    elements.filePickerButtonEl.click();
    const clickSpy = vi.spyOn(elements.fileInputEl, "click");
    const options = elements.filePickerMenuEl.querySelectorAll(
      ".hermesian-file-picker-option",
    );
    (options[0] as HTMLButtonElement).click();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(elements.filePickerMenuEl.style.display).toBe("none");
  });

  it("triggers the folder input from the 选择文件夹… option and hides the menu", () => {
    const { elements } = setup();
    elements.filePickerButtonEl.click();
    const clickSpy = vi.spyOn(elements.folderInputEl, "click");
    const options = elements.filePickerMenuEl.querySelectorAll(
      ".hermesian-file-picker-option",
    );
    (options[1] as HTMLButtonElement).click();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(elements.filePickerMenuEl.style.display).toBe("none");
  });

  it("closes the menu when clicking outside the button and menu", () => {
    const { elements } = setup();
    elements.filePickerButtonEl.click();
    expect(elements.filePickerMenuEl.style.display).not.toBe("none");
    document.body.click();
    expect(elements.filePickerMenuEl.style.display).toBe("none");
  });

  it("keeps current-file bar, input row, footer, and a hidden slash token host", () => {
    const { elements, parent } = setup();
    expect(parent.querySelector(".hermesian-current-file")).toBeTruthy();
    expect(parent.querySelector(".hermesian-composer-footer")).toBeTruthy();
    expect(elements.composerInputRowEl.classList.contains("hermesian-composer-input-row")).toBe(
      true,
    );
    expect(elements.slashTokenEl.classList.contains("hermesian-slash-token")).toBe(true);
    expect(elements.slashTokenEl.style.display).toBe("none");
    expect(elements.composerInputRowEl.contains(elements.composerEl)).toBe(true);
    expect(elements.composerInputRowEl.contains(elements.slashTokenEl)).toBe(true);
  });
});

describe("composer callbacks", () => {
  it("calls onDraftChange with the synced model when the user types", () => {
    const { elements, callbacks } = setup();
    elements.composerEl.textContent = "new text";
    elements.composerEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(callbacks.onDraftChange).toHaveBeenCalledWith(
      draft({ text: "new text" }),
    );
  });

  it("calls onSend on Send button click", () => {
    const { elements, callbacks } = setup();
    elements.sendButtonEl.click();
    expect(callbacks.onSend).toHaveBeenCalledOnce();
  });

  it("does not call onSend on Send button click when sendEnabled is false", () => {
    const { elements, callbacks } = setup({ sendEnabled: false });
    elements.sendButtonEl.click();
    expect(callbacks.onSend).not.toHaveBeenCalled();
  });

  it("calls onStop on Stop button click", () => {
    const { elements, callbacks } = setup({ stopVisible: true, primaryMode: "stop" });
    elements.stopButtonEl.click();
    expect(callbacks.onStop).toHaveBeenCalledOnce();
  });

  it("calls onSteer on Steer button click when visible", () => {
    const { elements, callbacks } = setup({
      primaryMode: "stop-steer",
      stopVisible: true,
      steerEnabled: true,
    });
    elements.steerButtonEl.click();
    expect(callbacks.onSteer).toHaveBeenCalledOnce();
  });

  it("calls onDictation on microphone button click", () => {
    const { elements, callbacks } = setup();
    elements.dictationButtonEl.click();
    expect(callbacks.onDictation).toHaveBeenCalledOnce();
  });

  it("calls onPaste on paste event (image handling stays host-side)", () => {
    const { elements, callbacks } = setup();
    const event = new ClipboardEvent("paste", { bubbles: true });
    elements.composerEl.dispatchEvent(event);
    expect(callbacks.onPaste).toHaveBeenCalledOnce();
  });

  it("forwards keydown, copy, and cut events to the host", () => {
    const { elements, callbacks } = setup();
    elements.composerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(callbacks.onKeydown).toHaveBeenCalledOnce();
    elements.composerEl.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true }),
    );
    expect(callbacks.onCopy).toHaveBeenCalledOnce();
    elements.composerEl.dispatchEvent(
      new ClipboardEvent("cut", { bubbles: true, cancelable: true }),
    );
    expect(callbacks.onCut).toHaveBeenCalledOnce();
  });
});

describe("applyComposerState", () => {
  let elements: ReturnType<typeof setup>["elements"];

  beforeEach(() => {
    elements = setup().elements;
  });

  it("updates disabled state on the editor", () => {
    applyComposerState(elements, defaultState({ disabled: true }));
    expect(elements.composerEl.contentEditable).toBe("false");

    applyComposerState(elements, defaultState({ disabled: false }));
    expect(elements.composerEl.contentEditable).toBe("true");
  });

  it("disables the file picker button when the composer is disabled", () => {
    applyComposerState(elements, defaultState({ disabled: true }));
    expect(elements.filePickerButtonEl.disabled).toBe(true);

    applyComposerState(elements, defaultState({ disabled: false }));
    expect(elements.filePickerButtonEl.disabled).toBe(false);
  });

  it("disables Send button when sendEnabled is false", () => {
    applyComposerState(elements, defaultState({ sendEnabled: false }));
    expect(elements.sendButtonEl.disabled).toBe(true);
  });

  it("shows Stop and hides Send when stopVisible is true", () => {
    applyComposerState(elements, defaultState({ stopVisible: true }));
    // Send is hidden, Stop is shown
    expect(elements.stopButtonEl.style.display).not.toBe("none");
  });

  it("state transitions from send→stop→send work correctly", () => {
    // Start: send visible
    applyComposerState(elements, defaultState({ stopVisible: false }));
    expect(elements.sendButtonEl.style.display).not.toBe("none");

    // Switch to stop
    applyComposerState(elements, defaultState({ stopVisible: true }));
    expect(elements.stopButtonEl.style.display).not.toBe("none");

    // Switch back to send
    applyComposerState(elements, defaultState({ stopVisible: false }));
    expect(elements.sendButtonEl.style.display).not.toBe("none");
  });

  it("shows Stop + Steer together for steerable active turns", () => {
    applyComposerState(
      elements,
      defaultState({
        primaryMode: "stop-steer",
        stopVisible: true,
        steerEnabled: true,
        sendEnabled: false,
      }),
    );
    expect(elements.sendButtonEl.style.display).toBe("none");
    expect(elements.stopButtonEl.style.display).not.toBe("none");
    expect(elements.steerButtonEl.style.display).not.toBe("none");
    expect(elements.steerButtonEl.disabled).toBe(false);
  });

  it("disables Steer while a steer is in flight", () => {
    applyComposerState(
      elements,
      defaultState({
        primaryMode: "stop-steer",
        stopVisible: true,
        steerEnabled: false,
      }),
    );
    expect(elements.steerButtonEl.disabled).toBe(true);
  });

  it("shows Stopping… and disables Stop during stop-and-send", () => {
    applyComposerState(
      elements,
      defaultState({
        primaryMode: "stopping",
        stopVisible: true,
        stopEnabled: false,
      }),
    );
    expect(elements.stopButtonEl.style.display).not.toBe("none");
    expect(elements.stopButtonEl.disabled).toBe(true);
    expect(elements.stopButtonEl.getAttribute("aria-label")).toBe("Stopping…");
    expect(elements.statusEl.textContent).toBe("Stopping…");
    expect(elements.steerButtonEl.style.display).toBe("none");
  });

  it("exposes listening dictation state with accessible pressed label", () => {
    applyComposerState(
      elements,
      defaultState({
        dictationPhase: "listening",
        dictationEnabled: true,
      }),
    );
    expect(elements.dictationButtonEl.getAttribute("aria-pressed")).toBe("true");
    expect(elements.dictationButtonEl.getAttribute("aria-label")).toBe("Stop dictation");
    expect(elements.dictationButtonEl.classList.contains("is-listening")).toBe(true);
    expect(elements.statusEl.textContent).toBe("Listening…");
  });

  it("surfaces composer hints for steer reject / STT errors", () => {
    applyComposerState(
      elements,
      defaultState({
        hint: "Steer only accepts plain text. Draft kept.",
      }),
    );
    expect(elements.hintEl.style.display).not.toBe("none");
    expect(elements.hintEl.textContent).toContain("Steer only accepts plain text");
  });
});

describe("file picker menu: open callback, disabled state, disposal", () => {
  it("calls onFilePickerOpen(\"file\") BEFORE the native input opens", () => {
    const onFilePickerOpen = vi.fn();
    const { elements } = setup({}, { onFilePickerOpen });
    elements.filePickerButtonEl.click();
    const clickSpy = vi.spyOn(elements.fileInputEl, "click");
    const options = elements.filePickerMenuEl.querySelectorAll<HTMLButtonElement>(
      ".hermesian-file-picker-option",
    );
    options[0]!.click();
    expect(onFilePickerOpen).toHaveBeenCalledWith("file");
    expect(clickSpy).toHaveBeenCalledOnce();
    // onFilePickerOpen must fire BEFORE input.click() so the host can
    // capture the caret while the editor is still focused.
    expect(onFilePickerOpen.mock.invocationCallOrder[0]).toBeLessThan(
      clickSpy.mock.invocationCallOrder[0],
    );
  });

  it("calls onFilePickerOpen(\"folder\") BEFORE the folder input opens", () => {
    const onFilePickerOpen = vi.fn();
    const { elements } = setup({}, { onFilePickerOpen });
    elements.filePickerButtonEl.click();
    const clickSpy = vi.spyOn(elements.folderInputEl, "click");
    const options = elements.filePickerMenuEl.querySelectorAll<HTMLButtonElement>(
      ".hermesian-file-picker-option",
    );
    options[1]!.click();
    expect(onFilePickerOpen).toHaveBeenCalledWith("folder");
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(onFilePickerOpen.mock.invocationCallOrder[0]).toBeLessThan(
      clickSpy.mock.invocationCallOrder[0],
    );
  });

  it("hides and disables the menu options when the composer is disabled", () => {
    const { elements } = setup();
    elements.filePickerButtonEl.click();
    expect(elements.filePickerMenuEl.style.display).not.toBe("none");

    applyComposerState(elements, defaultState({ disabled: true }));
    expect(elements.filePickerMenuEl.style.display).toBe("none");
    const options = elements.filePickerMenuEl.querySelectorAll<HTMLButtonElement>(
      ".hermesian-file-picker-option",
    );
    expect(options).toHaveLength(2);
    expect(options[0]!.disabled).toBe(true);
    expect(options[1]!.disabled).toBe(true);

    // A disabled option must not open the native dialog (clicks suppressed).
    const fileClick = vi.spyOn(elements.fileInputEl, "click");
    const folderClick = vi.spyOn(elements.folderInputEl, "click");
    options[0]!.click();
    options[1]!.click();
    expect(fileClick).not.toHaveBeenCalled();
    expect(folderClick).not.toHaveBeenCalled();

    // Re-enabling restores the options.
    applyComposerState(elements, defaultState({ disabled: false }));
    const reenabled = elements.filePickerMenuEl.querySelectorAll<HTMLButtonElement>(
      ".hermesian-file-picker-option",
    );
    expect(reenabled[0]!.disabled).toBe(false);
    expect(reenabled[1]!.disabled).toBe(false);
  });

  it("dispose() detaches the outside-click listener so an open menu stays open", () => {
    const { elements } = setup();
    elements.filePickerButtonEl.click();
    expect(elements.filePickerMenuEl.style.display).not.toBe("none");
    elements.dispose?.();
    document.body.click();
    expect(elements.filePickerMenuEl.style.display).not.toBe("none");
  });

  it("does not accumulate outside-click listeners across create→dispose cycles", () => {
    const parent = document.createElement("div");
    const makeView = (): ReturnType<typeof createComposerView> => {
      const callbacks: ComposerCallbacks = {
        getDraft: () => emptyDraft(),
        onDraftChange: vi.fn(),
        onPaste: vi.fn(),
        onSend: vi.fn(),
        onStop: vi.fn(),
        onKeydown: vi.fn(),
      };
      return createComposerView(parent, defaultState(), callbacks);
    };
    const first = makeView();
    const second = makeView();
    first.filePickerButtonEl.click();
    expect(first.filePickerMenuEl.style.display).not.toBe("none");
    first.dispose?.();

    second.filePickerButtonEl.click();
    expect(second.filePickerMenuEl.style.display).not.toBe("none");
    document.body.click();
    // Only the live instance's listener remains: second closes, first stays open.
    expect(second.filePickerMenuEl.style.display).toBe("none");
    expect(first.filePickerMenuEl.style.display).not.toBe("none");
  });
});

describe("applyComposerSlashToken", () => {
  it("renders a skill capsule with accessible name and capsule class", () => {
    const { elements } = setup();
    applyComposerSlashToken(elements, { kind: "skill", name: "leader" });

    expect(elements.slashTokenEl.style.display).not.toBe("none");
    expect(elements.slashTokenEl.classList.contains("is-skill")).toBe(true);
    expect(elements.slashTokenEl.classList.contains("is-command")).toBe(false);
    expect(elements.slashTokenEl.classList.contains("is-capsule")).toBe(true);
    expect(elements.slashTokenLabelEl.textContent).toBe("/leader");
    expect(elements.slashTokenEl.getAttribute("aria-label")).toBe("Skill /leader");
  });

  it("renders a native command as blue inline token without capsule border class", () => {
    const { elements } = setup();
    applyComposerSlashToken(elements, { kind: "command", name: "model" });

    expect(elements.slashTokenEl.style.display).not.toBe("none");
    expect(elements.slashTokenEl.classList.contains("is-command")).toBe(true);
    expect(elements.slashTokenEl.classList.contains("is-skill")).toBe(false);
    expect(elements.slashTokenEl.classList.contains("is-capsule")).toBe(false);
    expect(elements.slashTokenLabelEl.textContent).toBe("/model");
    expect(elements.slashTokenEl.getAttribute("aria-label")).toBe("Command /model");
  });

  it("hides the token when cleared and keeps the editor surface intact", () => {
    const { elements } = setup();
    applyComposerSlashToken(elements, { kind: "skill", name: "leader" });
    expect(elements.slashTokenEl.style.display).not.toBe("none");

    applyComposerSlashToken(elements, null);
    expect(elements.slashTokenEl.style.display).toBe("none");
    expect(elements.slashTokenLabelEl.textContent).toBe("");
  });

  it("forwards every keydown to the host (slash clear is a host decision now)", () => {
    const { elements, callbacks } = setup();
    applyComposerSlashToken(elements, { kind: "skill", name: "leader" });
    elements.composerEl.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(callbacks.onKeydown).toHaveBeenCalledOnce();
  });
});

describe("composer reference chips (legacy container API)", () => {
  it("renders a url chip with neutral capsule class, ellipsis label, title, and accessible name", () => {
    const { elements, callbacks } = setup();
    applyComposerReferences(
      elements,
      [{ kind: "url", value: "https://example.com/a" }],
      { onRemoveReference: callbacks.onReferenceRemove },
    );

    expect(elements.referenceChipsEl.style.display).not.toBe("none");
    const chips = elements.referenceChipsEl.querySelectorAll(".hermesian-ref-token");
    expect(chips).toHaveLength(1);
    const chip = chips[0] as HTMLElement;
    expect(chip.classList.contains("is-url")).toBe(true);
    expect(chip.classList.contains("is-path")).toBe(false);
    expect(chip.querySelector(".hermesian-ref-token-label")!.textContent).toBe("example.com");
    expect(chip.getAttribute("title")).toBe("https://example.com/a");
    expect(chip.getAttribute("aria-label")).toBe(
      "Remove reference URL https://example.com/a",
    );
    // chips render inside the input row
    expect(elements.composerInputRowEl.contains(chip)).toBe(true);
  });

  it("renders a path chip with its own category class and file icon slot", () => {
    const { elements, callbacks } = setup();
    const renderIcon = vi.fn();
    applyComposerReferences(
      elements,
      [{ kind: "path", value: "/Users/中文 空格/笔记.md" }],
      { onRemoveReference: callbacks.onReferenceRemove, renderIcon },
    );

    const chip = elements.referenceChipsEl.querySelector(
      ".hermesian-ref-token",
    ) as HTMLElement;
    expect(chip.classList.contains("is-path")).toBe(true);
    expect(chip.classList.contains("is-url")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe(
      "Remove reference path /Users/中文 空格/笔记.md",
    );
    expect(renderIcon).toHaveBeenCalledWith(expect.any(HTMLElement), "path");
  });

  it("renders multiple reference chips in paste order", () => {
    const { elements, callbacks } = setup();
    applyComposerReferences(
      elements,
      [
        { kind: "url", value: "https://example.com/a" },
        { kind: "path", value: "/Users/笔记 空格.md" },
        { kind: "url", value: "https://example.com/b" },
      ],
      { onRemoveReference: callbacks.onReferenceRemove },
    );

    const labels = Array.from(
      elements.referenceChipsEl.querySelectorAll(".hermesian-ref-token-label"),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      "example.com",
      "笔记 空格.md",
      "example.com",
    ]);
  });

  it("shows only the host on a long URL chip while title and aria keep the full URL", () => {
    const { elements, callbacks } = setup();
    const url =
      "https://example.com/very/long/path/page.html?q=%E4%B8%AD%E6%96%87&x=1234567890#section-2";
    applyComposerReferences(elements, [{ kind: "url", value: url }], {
      onRemoveReference: callbacks.onReferenceRemove,
    });

    const chip = elements.referenceChipsEl.querySelector(
      ".hermesian-ref-token",
    ) as HTMLElement;
    expect(chip.querySelector(".hermesian-ref-token-label")!.textContent).toBe("example.com");
    expect(chip.getAttribute("title")).toBe(url);
    expect(chip.getAttribute("aria-label")).toBe(`Remove reference URL ${url}`);
  });

  it("shows only the basename on a path chip while title and aria keep the full path", () => {
    const { elements, callbacks } = setup();
    applyComposerReferences(
      elements,
      [{ kind: "path", value: "/Users/中文 空格/文献笔记.md" }],
      { onRemoveReference: callbacks.onReferenceRemove },
    );

    const chip = elements.referenceChipsEl.querySelector(
      ".hermesian-ref-token",
    ) as HTMLElement;
    expect(chip.querySelector(".hermesian-ref-token-label")!.textContent).toBe("文献笔记.md");
    expect(chip.getAttribute("title")).toBe("/Users/中文 空格/文献笔记.md");
    expect(chip.getAttribute("aria-label")).toBe(
      "Remove reference path /Users/中文 空格/文献笔记.md",
    );
  });

  it("shows the last non-empty segment for a directory path with a trailing slash", () => {
    const { elements, callbacks } = setup();
    applyComposerReferences(
      elements,
      [{ kind: "path", value: "/Users/a/文献笔记/" }],
      { onRemoveReference: callbacks.onReferenceRemove },
    );

    const chip = elements.referenceChipsEl.querySelector(
      ".hermesian-ref-token",
    ) as HTMLElement;
    expect(chip.querySelector(".hermesian-ref-token-label")!.textContent).toBe("文献笔记");
    expect(chip.getAttribute("title")).toBe("/Users/a/文献笔记/");
  });

  it("hides the chips container when there are no references", () => {
    const { elements, callbacks } = setup();
    applyComposerReferences(elements, [], {
      onRemoveReference: callbacks.onReferenceRemove,
    });
    expect(elements.referenceChipsEl.querySelectorAll(".hermesian-ref-token")).toHaveLength(0);
    expect(elements.referenceChipsEl.style.display).toBe("none");
  });

  it("removes the clicked chip by index", () => {
    const { elements } = setup();
    const onRemoveReference = vi.fn();
    applyComposerReferences(
      elements,
      [
        { kind: "url", value: "https://example.com/a" },
        { kind: "url", value: "https://example.com/b" },
      ],
      { onRemoveReference },
    );

    const chips = elements.referenceChipsEl.querySelectorAll(".hermesian-ref-token");
    (chips[1] as HTMLElement).click();
    expect(onRemoveReference).toHaveBeenCalledWith(1);
  });
});

describe("inline capsule rendering inside the editor", () => {
  it("renders reference capsules inline in the editor with full values in the model", () => {
    const { elements } = setup({
      draft: draft({
        text: "前文https://example.com/a后文",
        references: [{ kind: "url", value: "https://example.com/a", start: 2 }],
      }),
    });
    const capsules = elements.composerEl.querySelectorAll(".hermesian-inline-ref");
    expect(capsules).toHaveLength(1);
    const capsule = capsules[0] as HTMLElement;
    expect(capsule.getAttribute("contenteditable")).toBe("false");
    expect(capsule.getAttribute("title")).toBe("https://example.com/a");
    expect(capsule.getAttribute("aria-label")).toBe(
      "Reference URL https://example.com/a",
    );
    expect(
      readInlineDraftFromDom(elements.composerEl).text,
    ).toBe("前文https://example.com/a后文");
  });

  it("wires the capsule remove button to onReferenceRemove", () => {
    const { elements, callbacks } = setup({
      draft: draft({
        text: "https://example.com/a",
        references: [{ kind: "url", value: "https://example.com/a", start: 0 }],
      }),
    });
    const capsule = elements.composerEl.querySelector(
      ".hermesian-inline-ref",
    ) as HTMLElement;
    const button = capsule.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe(
      "Remove reference URL https://example.com/a",
    );
    button.click();
    expect(callbacks.onReferenceRemove).toHaveBeenCalledWith(0);
  });

  it("keeps the empty editor as a placeholder surface (no child nodes)", () => {
    const { elements } = setup();
    expect(elements.composerEl.childNodes).toHaveLength(0);
  });
});

describe("slash token single source (production paths)", () => {
  /**
   * Host harness mirroring HermesianSidebarView's composer wiring: the view
   * keeps ONE draft model (composerDraft); the editor reads it back through
   * getDraft() on every input; every mutation updates the model FIRST and
   * only then projects UI (applyComposerSlashToken just mirrors the model).
   * Menu selection, external restore, capture and clear all flow through
   * composerDraft.token, and the canonical send/persist string is
   * serializeComposerInlineDraft — the same functions view.ts calls.
   */
  function setupHost() {
    const parent = document.createElement("div");
    let hostDraft: ComposerInlineDraft = emptyDraft();
    const onDraftChange = vi.fn((draft: ComposerInlineDraft) => {
      hostDraft = draft;
    });
    const callbacks = {
      getDraft: () => hostDraft,
      onDraftChange,
      onPaste: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      onKeydown: vi.fn(),
      onCopy: vi.fn(),
      onCut: vi.fn(),
      onReferenceRemove: vi.fn(),
      renderIcon: vi.fn(),
    };
    const elements = createComposerView(parent, defaultState(), callbacks);

    // Mirrors view.setComposerSlashToken: model first, then UI projection.
    const setToken = (token: ComposerSlashToken | null): void => {
      hostDraft = { ...hostDraft, token };
      applyComposerSlashToken(elements, token);
    };

    // Mirrors view.applyComposerCanonicalDraft (tab restore path).
    const applyRestoredDraft = (draft: ComposerInlineDraft): void => {
      hostDraft = draft;
      applyComposerSlashToken(elements, draft.token);
      applyComposerDraft(elements, draft, {
        onReferenceRemove: callbacks.onReferenceRemove,
        renderIcon: callbacks.renderIcon,
      });
    };

    // Real input event through the editor's production listener.
    const typeText = (text: string): ComposerInlineDraft => {
      elements.composerEl.appendChild(document.createTextNode(text));
      elements.composerEl.dispatchEvent(new Event("input", { bubbles: true }));
      return hostDraft;
    };

    // Real Backspace keydown through the production keydown chain.
    const pressBackspace = (): { slashClearRequested?: boolean } => {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      });
      const result = handleInlineEditorKeydown(elements.composerEl, event, hostDraft, {
        onRemoveReference: callbacks.onReferenceRemove,
        renderIcon: callbacks.renderIcon,
      });
      if (result.slashClearRequested) {
        setToken(null);
      }
      return result;
    };

    return {
      parent,
      elements,
      callbacks,
      hostDraft: () => hostDraft,
      setToken,
      applyRestoredDraft,
      typeText,
      pressBackspace,
    };
  }

  it("keeps a host-applied /leader token across ordinary input (no creation-time snapshot)", () => {
    const { elements, setToken, typeText, hostDraft, callbacks } = setupHost();
    // Fresh composer: token starts null.
    expect(hostDraft().token).toBeNull();

    // External restore path: host applies the persisted /leader draft.
    setToken({ kind: "skill", name: "leader" });
    expect(elements.slashTokenLabelEl.textContent).toBe("/leader");
    expect(elements.slashTokenEl.style.display).not.toBe("none");

    // Ordinary input must carry the SAME token into the model.
    typeText("测试");
    expect(callbacks.onDraftChange).toHaveBeenLastCalledWith({
      token: { kind: "skill", name: "leader" },
      text: "测试",
      references: [],
    });
    expect(hostDraft().token).toEqual({ kind: "skill", name: "leader" });
  });

  it("keeps a menu-selected token while typing and serializes to /skill leader 任务", () => {
    const { setToken, typeText, hostDraft } = setupHost();
    // Real menu item → real token extraction (chooseSlashMenuItem path).
    const item: SlashMenuItem = {
      kind: "skill",
      name: "leader",
      description: "Split the goal into executable task books",
    };
    const token = composerSlashTokenFromMenuItem(item);
    expect(token).toEqual({ kind: "skill", name: "leader" });

    setToken(token);
    typeText("任务");

    expect(hostDraft().token).toEqual({ kind: "skill", name: "leader" });
    expect(serializeComposerInlineDraft(hostDraft())).toBe("/skill leader 任务");
  });

  it("preserves token, reference start and full text through restore → input → persist → restore", () => {
    const { applyRestoredDraft, typeText, hostDraft } = setupHost();
    // Tab restore: raw draft + explicit token/reference metadata.
    const restored = restoreComposerInlineDraft(
      "/skill leader 测试 https://example.com/a",
      { kind: "skill", name: "leader" },
      [{ kind: "url", value: "https://example.com/a", start: 3 }],
    );
    expect(restored.token).toEqual({ kind: "skill", name: "leader" });
    applyRestoredDraft(restored);

    // User types at the end of the restored text.
    typeText("任务");
    const persisted = hostDraft();
    expect(persisted.token).toEqual({ kind: "skill", name: "leader" });
    expect(persisted.references).toEqual([
      { kind: "url", value: "https://example.com/a", start: 3 },
    ]);
    expect(persisted.text).toBe("测试 https://example.com/a任务");

    // Persist (capture) → restore round-trip must keep everything identical.
    const canonical = serializeComposerInlineDraft(persisted);
    expect(canonical).toBe("/skill leader 测试 https://example.com/a任务");
    const roundTrip = restoreComposerInlineDraft(
      canonical,
      persisted.token,
      persisted.references,
    );
    expect(roundTrip.token).toEqual(persisted.token);
    expect(roundTrip.references).toEqual(persisted.references);
    expect(roundTrip.text).toBe(persisted.text);
  });

  it("clears the token display and the canonical string together on empty Backspace", () => {
    const { elements, setToken, pressBackspace, hostDraft } = setupHost();
    setToken({ kind: "skill", name: "leader" });
    expect(elements.slashTokenEl.style.display).not.toBe("none");
    expect(serializeComposerInlineDraft(hostDraft())).toBe("/skill leader ");

    // Real Backspace on the empty editor → slashClearRequested → host clears.
    const result = pressBackspace();
    expect(result.slashClearRequested).toBe(true);
    expect(elements.slashTokenEl.style.display).toBe("none");
    expect(elements.slashTokenLabelEl.textContent).toBe("");
    expect(hostDraft().token).toBeNull();
    expect(serializeComposerInlineDraft(hostDraft())).toBe("");
  });
});
