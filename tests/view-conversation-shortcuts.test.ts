import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices: string[] = [];

beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("KeyboardEvent", window.KeyboardEvent);
});

vi.mock("obsidian", () => ({
  ItemView: class {
    app: unknown;
    containerEl = document.createElement("div");
    constructor(leaf: { app: unknown }) {
      this.app = leaf.app;
    }
  },
  Modal: class {},
  SuggestModal: class {},
  MarkdownView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn(async () => undefined) },
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
  setIcon: vi.fn(),
}));

import { HermesianSidebarView } from "../src/view";

function shortcutView() {
  const view = Object.create(HermesianSidebarView.prototype) as any;
  const registered: Array<(event: KeyboardEvent) => void> = [];
  view.containerEl = document.createElement("div");
  const composer = document.createElement("div");
  const outside = document.createElement("div");
  composer.tabIndex = 0;
  outside.tabIndex = 0;
  view.containerEl.appendChild(composer);
  document.body.append(view.containerEl, outside);
  view.registerDomEvent = vi.fn((_doc, type, callback) => {
    registered.push(callback);
    document.addEventListener(type, callback);
  });
  view.addConversation = vi.fn(async () => undefined);
  view.closeConversation = vi.fn(async () => undefined);
  view.activeConversationTab = vi.fn(() => ({ id: "active-tab" }));
  view.bindConversationShortcuts();
  view.bindConversationShortcuts();
  return { view, composer, outside, registered };
}

function press(target: HTMLElement, overrides: Record<string, unknown> = {}) {
  target.focus();
  const event = new KeyboardEvent("keydown", {
    key: "˜",
    code: "KeyN",
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  for (const [property, value] of Object.entries(overrides)) {
    Object.defineProperty(event, property, { value });
  }
  if (!("code" in overrides)) {
    Object.defineProperty(event, "code", { value: "KeyN" });
  }
  target.dispatchEvent(event);
  return event;
}

describe("Hermesian sidebar conversation shortcuts", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    notices.length = 0;
  });

  it("registers once and creates or closes the active conversation inside the sidebar", () => {
    const h = shortcutView();
    expect(h.view.registerDomEvent).toHaveBeenCalledOnce();

    const add = press(h.composer);
    expect(add.defaultPrevented).toBe(true);
    expect(h.view.addConversation).toHaveBeenCalledOnce();

    const close = press(h.composer, { key: "∑", code: "KeyW" });
    expect(close.defaultPrevented).toBe(true);
    expect(h.view.closeConversation).toHaveBeenCalledWith("active-tab");
  });

  it("accepts focus in each Hermesian-owned popover", () => {
    const h = shortcutView();
    for (const property of [
      "titlePopover",
      "modelPicker",
      "reasoningPicker",
      "contextGaugePopover",
    ]) {
      const popover = document.createElement("div");
      const input = document.createElement("input");
      popover.appendChild(input);
      document.body.appendChild(popover);
      h.view[property] = {
        contains: (target: Node) => popover.contains(target),
        detach: vi.fn(() => popover.remove()),
      };
      press(input);
      h.view[property] = null;
    }
    expect(h.view.addConversation).toHaveBeenCalledTimes(4);
  });

  it("dismisses model and reasoning pickers before switching tab ownership", () => {
    for (const [code, expectedAction] of [
      ["KeyN", "addConversation"],
      ["KeyW", "closeConversation"],
    ] as const) {
      const h = shortcutView();
      for (const property of ["modelPicker", "reasoningPicker"]) {
        const popover = document.createElement("div");
        const input = document.createElement("input");
        const anchor = document.createElement("button");
        popover.appendChild(input);
        document.body.append(popover, anchor);
        const detach = vi.fn(() => {
          popover.remove();
          anchor.focus();
        });
        h.view[property] = {
          contains: (target: Node) => popover.contains(target),
          detach,
        };
        press(input, { code });
        expect(detach).toHaveBeenCalledOnce();
        expect(h.view[property]).toBeNull();
        popover.remove();
        anchor.remove();
      }
      expect(h.view[expectedAction]).toHaveBeenCalledTimes(2);
    }
  });

  it("leaves note editors, other UI, and unrelated modifiers untouched", () => {
    const h = shortcutView();
    for (const overrides of [
      {},
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: false },
      { code: "KeyA" },
    ]) {
      const event = press(h.outside, overrides);
      expect(event.defaultPrevented).toBe(false);
    }
    press(h.composer, { metaKey: true });
    expect(h.view.addConversation).not.toHaveBeenCalled();
    expect(h.view.closeConversation).not.toHaveBeenCalled();
  });

  it("consumes a recognized key even when the existing close guard refuses it", () => {
    const h = shortcutView();
    h.view.closeConversation = vi.fn(async () => undefined);
    const event = press(h.composer, { key: "∑", code: "KeyW" });
    expect(event.defaultPrevented).toBe(true);
    expect(h.view.closeConversation).toHaveBeenCalledWith("active-tab");
    expect(h.view.addConversation).not.toHaveBeenCalled();
  });
});

describe("Picked file path failure feedback", () => {
  beforeEach(() => {
    notices.length = 0;
  });

  it("reports an unavailable absolute path and preserves the draft", () => {
    const view = Object.create(HermesianSidebarView.prototype) as any;
    const input = document.createElement("input");
    const file = new File(["PDF"], "报告.pdf");
    Object.defineProperty(input, "files", { value: [file] });
    Object.defineProperty(input, "value", { value: "picked", writable: true });
    view.controlAvailability = () => ({ composer: true });
    view.hasPendingSend = () => false;
    view.pendingFilePickerCaret = null;
    view.composerDraft = { token: null, text: "保留的草稿", references: [] };
    view.insertPickedFileReference(input, false);

    expect(notices).toEqual(["Hermesian could not access the selected file path."]);
    expect(view.composerDraft.text).toBe("保留的草稿");
    expect(input.value).toBe("");
  });
});
