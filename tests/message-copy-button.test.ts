import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  ItemView: class {
    app: any;
    containerEl = document.createElement("div");
    constructor(leaf: any) {
      this.app = leaf.app;
    }
  },
  SuggestModal: class {},
  MarkdownView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn(async () => undefined) },
  Notice: vi.fn(),
  setIcon: vi.fn(),
}));

import { attachMessageCopyButton, HermesianSidebarView } from "../src/view";
import { MessageRenderer, TurnManager } from "../src/ui/message-renderer";

const stylesCss = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function getBlock(selector: string): string {
  const target = `${selector} {`;
  const start = stylesCss.lastIndexOf(target);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = stylesCss.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return stripComments(stylesCss.slice(start, end));
}

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("KeyboardEvent", window.KeyboardEvent);
  vi.stubGlobal("navigator", window.navigator);

  (HTMLElement.prototype as any).createDiv = function (options: any = {}) {
    const el = document.createElement("div");
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = String(options.text);
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
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
  (HTMLElement.prototype as any).setText = function (text: string) {
    this.textContent = text;
  };
  (HTMLElement.prototype as any).toggleClass = function (cls: string, value?: boolean) {
    if (value === undefined) {
      this.classList.toggle(cls);
    } else if (value) {
      this.classList.add(cls);
    } else {
      this.classList.remove(cls);
    }
  };
});

describe("styles.css copy button rules", () => {
  it("ensures .hermesian-message.is-assistant has position: relative", () => {
    const block = getBlock(".hermesian-message.is-assistant");
    expect(block).toMatch(/^\s*position:\s*relative;/m);
  });

  it("styles .hermesian-message-copy-button with correct dimensions, positioning, and zero-opacity default", () => {
    const block = getBlock(".hermesian-message-copy-button");
    expect(block).toMatch(/^\s*position:\s*absolute;/m);
    expect(block).toMatch(/^\s*top:\s*4px;/m);
    expect(block).toMatch(/^\s*right:\s*4px;/m);
    expect(block).toMatch(/^\s*width:\s*24px;/m);
    expect(block).toMatch(/^\s*height:\s*24px;/m);
    expect(block).toMatch(/^\s*opacity:\s*0;/m);
    expect(block).toMatch(/^\s*border-radius:\s*var\(--hermesian-radius-sm\);/m);
  });

  it("reveals the copy button on assistant message hover and keyboard focus", () => {
    const target =
      ".hermesian-message.is-assistant:hover .hermesian-message-copy-button,\n.hermesian-message-copy-button:focus-visible {";
    const start = stylesCss.indexOf(target);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = stylesCss.indexOf("}", start);
    const block = stripComments(stylesCss.slice(start, end));
    expect(block).toMatch(/^\s*opacity:\s*1;/m);
  });

  it("styles .hermesian-message-copy-button.is-copied with var(--color-green)", () => {
    const block = getBlock(".hermesian-message-copy-button.is-copied");
    expect(block).toMatch(/^\s*color:\s*var\(--color-green\);/m);
  });

  it("does not contain hardcoded colors in copy button rules", () => {
    const start = stylesCss.indexOf(".hermesian-message-copy-button {");
    const end = stylesCss.indexOf(
      ".hermesian-message-copy-button svg {",
    );
    const rules = stripComments(stylesCss.slice(start, end + 60));
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});

describe("attachMessageCopyButton behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createAssistantMessage(text = "Hello from Hermes"): {
    messageEl: HTMLElement;
    contentEl: HTMLElement;
  } {
    const messageEl = document.createElement("div");
    messageEl.className = "hermesian-message is-assistant";
    const contentEl = document.createElement("div");
    contentEl.className = "hermesian-message-content";
    contentEl.textContent = text;
    messageEl.appendChild(contentEl);
    return { messageEl, contentEl };
  }

  function iconTracker() {
    const icons: string[] = [];
    const iconRenderer = vi.fn((_el: HTMLElement, iconId: string) => {
      icons.push(iconId);
    });
    return { icons, iconRenderer };
  }

  it("attaches copy button to assistant message with accessible attributes", () => {
    const { messageEl } = createAssistantMessage();
    const { iconRenderer, icons } = iconTracker();

    const button = attachMessageCopyButton(messageEl, { iconRenderer });
    expect(button).toBeDefined();
    expect(button?.tagName.toLowerCase()).toBe("button");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy message");
    expect(button?.title).toBe("Copy message");
    expect(button?.classList.contains("hermesian-message-copy-button")).toBe(true);
    expect(icons).toEqual(["copy"]);
  });

  it("does not attach copy button to user messages", () => {
    const messageEl = document.createElement("div");
    messageEl.className = "hermesian-message is-user";
    const contentEl = document.createElement("div");
    contentEl.className = "hermesian-message-content";
    contentEl.textContent = "User query";
    messageEl.appendChild(contentEl);

    const button = attachMessageCopyButton(messageEl);
    expect(button).toBeUndefined();
    expect(messageEl.querySelector(".hermesian-message-copy-button")).toBeNull();
  });

  it("is idempotent: calling twice does not duplicate button", () => {
    const { messageEl } = createAssistantMessage();
    const { iconRenderer } = iconTracker();

    const btn1 = attachMessageCopyButton(messageEl, { iconRenderer });
    const btn2 = attachMessageCopyButton(messageEl, { iconRenderer });
    expect(btn1).toBeDefined();
    expect(btn2).toBeUndefined();
    expect(messageEl.querySelectorAll(".hermesian-message-copy-button").length).toBe(1);
  });

  it("calls clipboard.writeText with message text on click", async () => {
    const { messageEl } = createAssistantMessage("Here is the answer");
    const writeText = vi.fn(async (_text: string) => undefined);
    const { iconRenderer } = iconTracker();

    const button = attachMessageCopyButton(messageEl, {
      iconRenderer,
      clipboard: { writeText },
    });
    expect(button).toBeDefined();

    button!.click();
    await tick();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Here is the answer");
  });

  it("copies entire message text including code blocks", async () => {
    const { messageEl, contentEl } = createAssistantMessage();
    contentEl.innerHTML =
      "<p>Analysis:</p><pre><code>const answer = 42;\nreturn answer;</code></pre><p>All done.</p>";
    const writeText = vi.fn(async (_text: string) => undefined);

    const button = attachMessageCopyButton(messageEl, {
      clipboard: { writeText },
    });

    button!.click();
    await tick();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("const answer = 42;");
    expect(copied).toContain("All done.");
  });

  it("feedback state machine: enters check state and reverts after 2.5s", async () => {
    const { messageEl } = createAssistantMessage("Content to copy");
    const writeText = vi.fn(async (_text: string) => undefined);
    const { iconRenderer, icons } = iconTracker();

    const button = attachMessageCopyButton(messageEl, {
      iconRenderer,
      clipboard: { writeText },
      timeoutMs: 2500,
    });
    expect(icons).toEqual(["copy"]);

    // Click -> copies and transitions to check
    button!.click();
    await tick();

    expect(icons).toEqual(["copy", "check"]);
    expect(button?.classList.contains("is-copied")).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Copied");
    expect(button?.title).toBe("Copied");

    // Advance 2000ms -> still in check state
    vi.advanceTimersByTime(2000);
    expect(button?.classList.contains("is-copied")).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Copied");

    // Advance remaining 500ms -> total 2500ms, reverts to copy icon
    vi.advanceTimersByTime(500);
    expect(button?.classList.contains("is-copied")).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("Copy message");
    expect(button?.title).toBe("Copy message");
    expect(icons).toEqual(["copy", "check", "copy"]);
  });

  it("uses 2500ms default timeout: still in check state at 2499ms and reverts at 2500ms", async () => {
    const { messageEl } = createAssistantMessage("Default timeout test");
    const writeText = vi.fn(async (_text: string) => undefined);
    const { iconRenderer, icons } = iconTracker();

    // Do NOT pass timeoutMs to verify default 2500ms
    const button = attachMessageCopyButton(messageEl, {
      iconRenderer,
      clipboard: { writeText },
    });

    button!.click();
    await tick();

    expect(icons).toEqual(["copy", "check"]);
    expect(button?.classList.contains("is-copied")).toBe(true);

    // Advance 2499ms -> still check state
    vi.advanceTimersByTime(2499);
    expect(button?.classList.contains("is-copied")).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Copied");
    expect(icons).toEqual(["copy", "check"]);

    // Advance 1ms (total 2500ms) -> reverts to copy icon
    vi.advanceTimersByTime(1);
    expect(button?.classList.contains("is-copied")).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("Copy message");
    expect(icons).toEqual(["copy", "check", "copy"]);
  });

  it("resets 2.5s timer when clicked again while in copied state", async () => {
    const { messageEl } = createAssistantMessage("Content to copy");
    const writeText = vi.fn(async (_text: string) => undefined);
    const { iconRenderer, icons } = iconTracker();

    const button = attachMessageCopyButton(messageEl, {
      iconRenderer,
      clipboard: { writeText },
      timeoutMs: 2500,
    });

    // First click at t=0
    button!.click();
    await tick();
    expect(icons).toEqual(["copy", "check"]);

    // Advance 1500ms
    vi.advanceTimersByTime(1500);

    // Second click at t=1500ms
    button!.click();
    await tick();
    expect(button?.classList.contains("is-copied")).toBe(true);

    // Advance 1500ms more (t=3000ms: 3000ms from start, but only 1500ms after second click)
    vi.advanceTimersByTime(1500);
    expect(button?.classList.contains("is-copied")).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Copied");

    // Advance remaining 1000ms (t=4000ms: 2500ms after second click)
    vi.advanceTimersByTime(1000);
    expect(button?.classList.contains("is-copied")).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("Copy message");
    expect(icons).toEqual(["copy", "check", "check", "copy"]);
  });

  it("does not enter check state when clipboard write fails and logs via debugLogger", async () => {
    const { messageEl } = createAssistantMessage("Failed write text");
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("Clipboard permission denied");
    });
    const warnSpy = vi.fn();
    const logger: any = {
      warn: warnSpy,
      debug: vi.fn(),
      error: vi.fn(),
    };
    const { iconRenderer, icons } = iconTracker();

    const button = attachMessageCopyButton(messageEl, {
      iconRenderer,
      clipboard: { writeText },
      logger,
    });

    button!.click();
    await tick();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("controller.background.failure", {
      operation: "copy-message",
      errorCode: "Error",
    });
    // Icon should stay "copy", not transition to "check"
    expect(icons).toEqual(["copy"]);
    expect(button?.classList.contains("is-copied")).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("Copy message");
  });

  it("does not emit bare console.warn when default logger is used and clipboard fails", async () => {
    const { messageEl } = createAssistantMessage("Failed write text");
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("Clipboard permission denied");
    });
    const consoleWarnSpy = vi.spyOn(console, "warn");

    const button = attachMessageCopyButton(messageEl, {
      clipboard: { writeText },
    });

    button!.click();
    await tick();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(button?.classList.contains("is-copied")).toBe(false);
  });
});

describe("streaming turn integration with copy button", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("automatically mounts copy button during streaming and captures current snapshot", async () => {
    const parent = document.createElement("div");
    const messagesEl = parent.createDiv({ cls: "hermesian-messages" });
    const renderer = new MessageRenderer(messagesEl);
    renderer.show("tab-1");

    const writeText = vi.fn(async (_text: string) => undefined);

    const turnManager = new TurnManager(renderer, {
      onTurnComplete: () => {},
      onAssistantMessageCreated: (messageEl) => {
        attachMessageCopyButton(messageEl, {
          iconRenderer: (_el, icon) => _el.setAttribute("data-icon", icon),
          clipboard: { writeText },
        });
      },
    });

    // Stream first delta
    turnManager.appendDelta("tab-1", "Streaming part 1...");

    const messageEl = messagesEl.querySelector<HTMLElement>(
      ".hermesian-message.is-assistant",
    );
    expect(messageEl).not.toBeNull();
    const copyButton = messageEl?.querySelector<HTMLButtonElement>(
      ".hermesian-message-copy-button",
    );
    expect(copyButton).not.toBeNull();
    expect(copyButton?.getAttribute("data-icon")).toBe("copy");

    // Click during streaming: copies part 1
    copyButton!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith("Streaming part 1...");

    // Stream second delta
    turnManager.appendDelta("tab-1", " and part 2!");

    // Click again: copies cumulative text snapshot
    copyButton!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith("Streaming part 1... and part 2!");
  });
});

describe("slash menu keyboard handling IME protection", () => {
  function createViewHarness() {
    const leaf = { app: { workspace: { layoutReady: false, onLayoutReady: vi.fn() } } };
    const plugin = {
      attachView: vi.fn(),
      getConversationControllerDependencies: vi.fn(),
      setConversationWorkspace: vi.fn(),
      getCurrentDocumentContext: vi.fn(),
      getCurrentMarkdownFilePath: vi.fn(),
      peekClient: vi.fn(),
      getClient: vi.fn(),
      settings: { debugLogging: false },
    };
    const view: any = new HermesianSidebarView(leaf as any, plugin as any);
    view.slashMenuEl = document.createElement("div");
    view.composerEl = document.createElement("div");
    view.slashMenuItems = [
      { kind: "command", name: "help", description: "Help" },
      { kind: "command", name: "model", description: "Switch model" },
    ];
    view.slashMenuIndex = 0;
    return { view };
  }

  it("does not consume ArrowDown when isComposing is true", () => {
    const { view } = createViewHarness();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      isComposing: true,
      cancelable: true,
    });
    const handled = view.handleSlashMenuKeydown(event);
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(view.slashMenuIndex).toBe(0);
  });

  it("does not consume ArrowDown when keyCode is 229", () => {
    const { view } = createViewHarness();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      isComposing: false,
      keyCode: 229,
      cancelable: true,
    });
    const handled = view.handleSlashMenuKeydown(event);
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(view.slashMenuIndex).toBe(0);
  });

  it("consumes ArrowDown when isComposing is false and not keyCode 229", () => {
    const { view } = createViewHarness();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      isComposing: false,
      keyCode: 40,
      cancelable: true,
    });
    const handled = view.handleSlashMenuKeydown(event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(view.slashMenuIndex).toBe(1);
  });
});

