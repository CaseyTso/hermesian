// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HermesTitlePopover,
  type HermesTitlePopoverOptions,
} from "../../src/ui/title-popover";

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 40,
    height: 30,
    left: 20,
    right: 60,
    top: 10,
    width: 40,
    x: 20,
    y: 10,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("HermesTitlePopover", () => {
  let anchor: HTMLButtonElement;

  beforeEach(() => {
    anchor = document.createElement("button");
    document.body.appendChild(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function openPopover(overrides: Partial<HermesTitlePopoverOptions> = {}) {
    const onRename = vi.fn(async (nextTitle: string) => nextTitle);
    const onGenerateAi = vi.fn(async () => "AI Generated Title");
    const onClose = vi.fn();
    const iconRenderer = vi.fn((element: HTMLElement, icon: string) => {
      element.dataset.icon = icon;
    });

    const popover = new HermesTitlePopover({
      anchorEl: anchor,
      tabId: "tab-1",
      tabLabel: 1,
      currentTitle: "未命名会话",
      hasCustomTitle: false,
      canGenerateAi: false,
      getViewport: () => ({ height: 768, width: 1024 }),
      getContainerRect: () => ({ left: 0, width: 320 }),
      iconRenderer,
      onRename,
      onGenerateAi,
      onClose,
      ...overrides,
    });

    popover.open();
    const container = document.body.querySelector(
      ".hermesian-title-popover",
    ) as HTMLElement;

    return {
      container,
      iconRenderer,
      onClose,
      onGenerateAi,
      onRename,
      popover,
    };
  }

  it("renders current title, heading, and no close button inside the popover", () => {
    const { container } = openPopover({ currentTitle: "Test Title" });

    expect(container).not.toBeNull();
    expect(container.tabIndex).toBe(-1);
    expect(container.getAttribute("role")).toBe("dialog");
    expect(container.getAttribute("aria-label")).toBe("Conversation title");

    const heading = container.querySelector(".hermesian-title-popover-heading");
    expect(heading?.textContent).toBe("CONVERSATION 1");

    // Must NOT have a close button in header or popover (Q1)
    const header = container.querySelector(".hermesian-title-popover-header")!;
    expect(header.querySelector("button")).toBeNull();
    expect(container.querySelector("[title='Close']")).toBeNull();
    expect(container.querySelector("[aria-label='Close']")).toBeNull();

    const titleText = container.querySelector(".hermesian-title-popover-title-text");
    expect(titleText?.textContent).toBe("Test Title");

    const displayRow = container.querySelector(".hermesian-title-popover-display")!;
    const rowChildren = Array.from(displayRow.children);
    expect(rowChildren.map((el) => el.className)).toEqual([
      "hermesian-title-popover-title-trigger",
      "clickable-icon hermesian-title-popover-icon-button hermesian-title-popover-edit-button",
      "clickable-icon hermesian-title-popover-icon-button hermesian-title-popover-ai-button",
    ]);
    expect(container.querySelector(".hermesian-title-popover-ai-label")).toBeNull();
  });

  it("switches to edit mode on clicking title trigger or edit icon button, and saves on Enter via onRename", async () => {
    const onRename = vi.fn(async (title: string) => `Renamed: ${title}`);
    const { container } = openPopover({
      currentTitle: "Original Title",
      hasCustomTitle: true,
      onRename,
    });

    const displayRow = container.querySelector<HTMLElement>(
      ".hermesian-title-popover-display",
    )!;
    const titleTriggerBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-title-trigger",
    )!;
    const editBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-edit-button",
    )!;
    const input = container.querySelector<HTMLInputElement>(
      ".hermesian-title-popover-input",
    )!;

    expect(displayRow.style.display).not.toBe("none");
    expect(input.style.display).toBe("none");

    titleTriggerBtn.click();

    expect(displayRow.style.display).toBe("none");
    expect(input.style.display).not.toBe("none");
    expect(input.value).toBe("Original Title");

    // Escape returns to display row, then edit icon button also enters edit mode
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(displayRow.style.display).not.toBe("none");
    editBtn.click();
    expect(displayRow.style.display).toBe("none");
    expect(input.style.display).not.toBe("none");

    input.value = "New User Title";
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enterEvent);

    await Promise.resolve();
    await Promise.resolve();

    expect(onRename).toHaveBeenCalledWith("New User Title");
    expect(input.style.display).toBe("none");
    expect(displayRow.style.display).not.toBe("none");
    expect(container.querySelector(".hermesian-title-popover-title-text")?.textContent).toBe(
      "Renamed: New User Title",
    );
  });

  it("displays error message and restores previous title when onRename rejects", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("Network rename error");
    });
    const { container } = openPopover({
      currentTitle: "Original Title",
      hasCustomTitle: true,
      onRename,
    });

    const editBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-edit-button",
    )!;
    const input = container.querySelector<HTMLInputElement>(
      ".hermesian-title-popover-input",
    )!;
    const errorEl = container.querySelector<HTMLElement>(
      ".hermesian-title-popover-error",
    )!;

    editBtn.click();
    input.value = "Failing Title";

    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enterEvent);

    await Promise.resolve();
    await Promise.resolve();

    expect(errorEl.style.display).not.toBe("none");
    expect(errorEl.textContent).toBe("Network rename error");
    // Display still has original title
    expect(container.querySelector(".hermesian-title-popover-title-text")?.textContent).toBe(
      "Original Title",
    );
  });

  it("shows error when attempting to submit an empty title", async () => {
    const onRename = vi.fn();
    const { container } = openPopover({
      currentTitle: "Original Title",
      hasCustomTitle: true,
      onRename,
    });

    const titleTriggerBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-title-trigger",
    )!;
    const input = container.querySelector<HTMLInputElement>(
      ".hermesian-title-popover-input",
    )!;
    const errorEl = container.querySelector<HTMLElement>(
      ".hermesian-title-popover-error",
    )!;

    titleTriggerBtn.click();
    input.value = "   ";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(errorEl.style.display).not.toBe("none");
    expect(errorEl.textContent).toBe("标题不能为空");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("exits edit mode on Escape without detaching popover, and detaches on Escape when not editing", () => {
    const { container, onClose, popover } = openPopover({ currentTitle: "Some Title" });

    const displayRow = container.querySelector<HTMLElement>(
      ".hermesian-title-popover-display",
    )!;
    const titleTriggerBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-title-trigger",
    )!;
    const input = container.querySelector<HTMLInputElement>(
      ".hermesian-title-popover-input",
    )!;

    titleTriggerBtn.click();
    expect(input.style.display).not.toBe("none");

    // Escape in input: exits edit mode
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(input.style.display).toBe("none");
    expect(displayRow.style.display).not.toBe("none");
    expect(popover.isOpen()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    // Escape when not editing: detaches
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(popover.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("detaches on outside pointerdown", () => {
    const { onClose, popover } = openPopover();
    expect(popover.isOpen()).toBe(true);

    const outsideEl = document.createElement("div");
    document.body.appendChild(outsideEl);

    outsideEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(popover.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("disables AI generate button with tooltip when canGenerateAi is false", () => {
    const { container, onGenerateAi } = openPopover({ canGenerateAi: false });

    const aiBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-ai-button",
    )!;
    expect(aiBtn.disabled).toBe(true);
    expect(aiBtn.getAttribute("aria-disabled")).toBe("true");
    expect(aiBtn.title).toBe("发送消息后可用");

    aiBtn.click();
    expect(onGenerateAi).not.toHaveBeenCalled();
  });

  it("immediately applies generated title on clicking AI generate button when enabled", async () => {
    const onGenerateAi = vi.fn(async () => "AI Generated Smart Title");
    const { container } = openPopover({
      canGenerateAi: true,
      currentTitle: "未命名会话",
      onGenerateAi,
    });

    const aiBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-ai-button",
    )!;
    expect(aiBtn.disabled).toBe(false);
    expect(aiBtn.title).toBe("使用 AI 生成会话标题");

    aiBtn.click();

    expect(aiBtn.classList.contains("is-loading")).toBe(true);
    expect(aiBtn.getAttribute("aria-busy")).toBe("true");
    expect(aiBtn.title).toBe("正在生成标题…");

    await Promise.resolve();
    await Promise.resolve();

    expect(onGenerateAi).toHaveBeenCalled();
    expect(container.querySelector(".hermesian-title-popover-title-text")?.textContent).toBe(
      "AI Generated Smart Title",
    );
    expect(aiBtn.classList.contains("is-loading")).toBe(false);
    expect(aiBtn.hasAttribute("aria-busy")).toBe(false);
    expect(aiBtn.title).toBe("使用 AI 生成会话标题");
    const titleTriggerBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-title-trigger",
    )!;
    expect(document.activeElement).toBe(titleTriggerBtn);
  });

  it("dismisses popover on document Escape even when focus is on document.body, and exits edit mode first if editing", () => {
    const { container, onClose, popover } = openPopover({ currentTitle: "Initial Title" });

    // Focus is on document.body
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    const displayRow = container.querySelector<HTMLElement>(
      ".hermesian-title-popover-display",
    )!;
    const titleTriggerBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-title-trigger",
    )!;
    const input = container.querySelector<HTMLInputElement>(
      ".hermesian-title-popover-input",
    )!;

    // Enter edit mode
    titleTriggerBtn.click();
    expect(input.style.display).not.toBe("none");

    // Press Escape on document while editing
    const escEvent1 = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escEvent1);

    // Exits edit mode without closing popover on the first Escape press
    expect(input.style.display).toBe("none");
    expect(displayRow.style.display).not.toBe("none");
    expect(popover.isOpen()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    // Ensure focus is on document.body
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    // Press Escape on document when not editing
    const escEvent2 = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escEvent2);

    // Popover closes on document Escape
    expect(popover.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("dynamically updates canGenerateAi state and hasCustomTitle via updateExternalTitle", () => {
    const { container, popover } = openPopover({
      canGenerateAi: false,
      currentTitle: "Initial Title",
      hasCustomTitle: false,
    });

    const aiBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-ai-button",
    )!;
    expect(aiBtn.disabled).toBe(true);
    expect(aiBtn.getAttribute("aria-disabled")).toBe("true");
    expect(aiBtn.title).toBe("发送消息后可用");

    // Update with canGenerateAi = true
    popover.updateExternalTitle("Updated Title", {
      canGenerateAi: true,
      hasCustomTitle: true,
    });

    expect(aiBtn.disabled).toBe(false);
    expect(aiBtn.hasAttribute("aria-disabled")).toBe(false);
    expect(aiBtn.title).toBe("使用 AI 生成会话标题");
    expect(container.querySelector(".hermesian-title-popover-title-text")?.textContent).toBe(
      "Updated Title",
    );

    // Update with canGenerateAi = false
    popover.updateExternalTitle("Updated Title 2", {
      canGenerateAi: false,
      hasCustomTitle: false,
    });

    expect(aiBtn.disabled).toBe(true);
    expect(aiBtn.getAttribute("aria-disabled")).toBe("true");
    expect(aiBtn.title).toBe("发送消息后可用");
  });

  it("renders model and reasoning selector capsules beside AI generate button and lets user pick them", () => {
    const sampleModels = [
      {
        description: "Fast & cheap",
        modelId: "gpt-4o-mini",
        name: "gpt-4o-mini",
        providerId: "openrouter",
        providerName: "OpenRouter",
        switchId: "openrouter:gpt-4o-mini",
      },
      {
        description: "Claude Haiku",
        modelId: "claude-3-5-haiku",
        name: "claude-3-5-haiku",
        providerId: "anthropic",
        providerName: "Anthropic",
        switchId: "anthropic:claude-3-5-haiku",
      },
    ];
    const onSelectAiModel = vi.fn();
    const onSelectAiReasoning = vi.fn();
    const { container, onClose, popover } = openPopover({
      canGenerateAi: true,
      models: sampleModels,
      onSelectAiModel,
      onSelectAiReasoning,
    });

    const modelBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-model-button",
    )!;
    const reasoningBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-reasoning-button",
    )!;
    expect(modelBtn.textContent).toContain("默认模型");
    expect(reasoningBtn.textContent).toContain("none");

    // 1. Open model sub-picker
    modelBtn.click();
    const searchEl = container.querySelector<HTMLInputElement>(
      ".hermesian-title-popover-search",
    )!;
    expect(searchEl.style.display).not.toBe("none");

    // Search for haiku
    searchEl.value = "haiku";
    searchEl.dispatchEvent(new Event("input", { bubbles: true }));
    const options = Array.from(
      container.querySelectorAll<HTMLElement>(".hermesian-title-popover-picker-option"),
    );
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("claude-3-5-haiku");

    // Click to select
    options[0].click();
    expect(onSelectAiModel).toHaveBeenCalledWith(sampleModels[1]);
    expect(modelBtn.textContent).toContain("claude-3-5-haiku");
    expect(modelBtn.title).toContain("Anthropic · claude-3-5-haiku");

    // 2. Open model sub-picker again and select "跟随 Hermes 默认"
    modelBtn.click();
    const allOptions = Array.from(
      container.querySelectorAll<HTMLElement>(".hermesian-title-popover-picker-option"),
    );
    expect(allOptions[0].textContent).toContain("跟随 Hermes 默认");
    allOptions[0].click();
    expect(onSelectAiModel).toHaveBeenLastCalledWith(undefined);
    expect(modelBtn.textContent).toContain("默认模型");

    // 3. Open reasoning sub-picker and press Escape -> returns to main without closing popover
    reasoningBtn.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(popover.isOpen()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    // 4. Open reasoning sub-picker and choose "high"
    reasoningBtn.click();
    const reasoningOptions = Array.from(
      container.querySelectorAll<HTMLElement>(".hermesian-title-popover-picker-option"),
    );
    const highOption = reasoningOptions.find((el) => el.textContent?.includes("high"))!;
    highOption.click();
    expect(onSelectAiReasoning).toHaveBeenCalledWith("high");
    expect(reasoningBtn.textContent).toContain("high");
  });

  it("updates model list dynamically via updateAiOptions while popover is open", () => {
    const { container, popover } = openPopover({
      models: [],
      catalogLoading: true,
    });

    const modelBtn = container.querySelector<HTMLButtonElement>(
      ".hermesian-title-popover-model-button",
    )!;
    modelBtn.click();
    expect(
      container.querySelector(".hermesian-title-popover-picker-empty")?.textContent,
    ).toContain("正在加载");

    popover.updateAiOptions({
      catalogLoading: false,
      models: [
        {
          description: "",
          modelId: "gpt-4o-mini",
          name: "gpt-4o-mini",
          providerId: "openrouter",
          providerName: "OpenRouter",
          switchId: "openrouter:gpt-4o-mini",
        },
      ],
    });
    const options = Array.from(
      container.querySelectorAll<HTMLElement>(".hermesian-title-popover-picker-option"),
    );
    expect(options.some((el) => el.textContent?.includes("gpt-4o-mini"))).toBe(true);
  });
});
