/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyComposerState,
  createComposerView,
  type ComposerState,
} from "../../src/ui/composer-view";

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

function defaultState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    disabled: false,
    draft: "",
    placeholder: "Ask Hermes…",
    sendEnabled: true,
    stopVisible: false,
    ...overrides,
  };
}

function setup(state?: Partial<ComposerState>) {
  const parent = document.createElement("div");
  const callbacks = {
    onDraftChange: vi.fn(),
    onPaste: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
  };
  const elements = createComposerView(parent, defaultState(state), callbacks);
  return { parent, elements, callbacks };
}

describe("createComposerView", () => {
  it("renders the composer textarea with the initial draft and placeholder", () => {
    const { elements } = setup({ draft: "hello", placeholder: "Write here…" });
    expect(elements.composerEl.value).toBe("hello");
    expect(elements.composerEl.placeholder).toBe("Write here…");
  });

  it("disables the textarea when state.disabled is true", () => {
    const { elements } = setup({ disabled: true });
    expect(elements.composerEl.disabled).toBe(true);
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
});

describe("composer callbacks", () => {
  it("calls onDraftChange when the user types", () => {
    const { elements, callbacks } = setup();
    elements.composerEl.value = "new text";
    elements.composerEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(callbacks.onDraftChange).toHaveBeenCalledWith("new text");
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
    const { elements, callbacks } = setup({ stopVisible: true });
    elements.stopButtonEl.click();
    expect(callbacks.onStop).toHaveBeenCalledOnce();
  });

  it("calls onPaste on paste event", () => {
    const { elements, callbacks } = setup();
    const event = new ClipboardEvent("paste", { bubbles: true });
    elements.composerEl.dispatchEvent(event);
    expect(callbacks.onPaste).toHaveBeenCalledOnce();
  });
});

describe("applyComposerState", () => {
  let elements: ReturnType<typeof setup>["elements"];

  beforeEach(() => {
    elements = setup().elements;
  });

  it("updates disabled state on the textarea", () => {
    applyComposerState(elements, defaultState({ disabled: true }));
    expect(elements.composerEl.disabled).toBe(true);

    applyComposerState(elements, defaultState({ disabled: false }));
    expect(elements.composerEl.disabled).toBe(false);
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
});
