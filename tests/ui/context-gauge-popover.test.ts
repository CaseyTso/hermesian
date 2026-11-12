// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HermesContextGaugePopover,
  type HermesContextGaugePopoverOptions,
} from "../../src/ui/context-gauge-popover";

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 40,
    height: 30,
    left: 200,
    right: 230,
    top: 10,
    width: 30,
    x: 200,
    y: 10,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("HermesContextGaugePopover", () => {
  let anchor: HTMLDivElement;

  beforeEach(() => {
    anchor = document.createElement("div");
    anchor.setAttribute("role", "button");
    anchor.setAttribute("tabindex", "0");
    document.body.appendChild(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function createPopover(overrides: Partial<HermesContextGaugePopoverOptions> = {}) {
    const onCompress = vi.fn(async () => {});
    const onClose = vi.fn();
    const iconRenderer = vi.fn((element: HTMLElement, icon: string) => {
      element.dataset.icon = icon;
    });

    const popover = new HermesContextGaugePopover({
      anchorEl: anchor,
      contextUsage: { used: 116_234, size: 1_000_000 },
      canCompress: { available: true },
      getViewport: () => ({ height: 768, width: 1024 }),
      getContainerRect: () => ({ left: 0, width: 320 }),
      iconRenderer,
      onCompress,
      onClose,
      ...overrides,
    });

    popover.open();
    const containers = document.body.querySelectorAll(
      ".hermesian-context-popover",
    );
    const container = containers[containers.length - 1] as HTMLElement;

    return {
      container,
      iconRenderer,
      onClose,
      onCompress,
      popover,
    };
  }

  it("mounts container with dialog semantics and aria-label", () => {
    const { container } = createPopover();
    expect(container).not.toBeNull();
    expect(container.getAttribute("role")).toBe("dialog");
    expect(container.getAttribute("aria-label")).toBe("上下文用量详情");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders large percentage, level attribute, and ring SVG", () => {
    const { container } = createPopover({
      contextUsage: { used: 116_234, size: 1_000_000 },
    });
    const percentage = container.querySelector(
      ".hermesian-context-popover-percentage",
    );
    expect(percentage?.textContent).toBe("12%");
    expect(container.dataset.level).toBe("normal");

    const fillCircle = container.querySelector(
      ".hermesian-context-popover-fill",
    ) as SVGCircleElement;
    expect(fillCircle).not.toBeNull();
    // 100.53 * (1 - 0.116234) ≈ 88.84
    expect(fillCircle.style.strokeDashoffset).toBe("88.84");
  });

  it("renders warning and danger tiers based on context ratio", () => {
    const { container: warningContainer } = createPopover({
      contextUsage: { used: 750_000, size: 1_000_000 },
    });
    expect(warningContainer.dataset.level).toBe("warning");

    const { container: dangerContainer } = createPopover({
      contextUsage: { used: 950_000, size: 1_000_000 },
    });
    expect(dangerContainer.dataset.level).toBe("danger");
  });

  it("renders exact千分位 numbers for used, total, and remaining tokens without cost", () => {
    const { container } = createPopover({
      contextUsage: { used: 116_234, size: 1_000_000 },
    });

    const statRows = container.querySelectorAll(
      ".hermesian-context-popover-stat-row",
    );
    expect(statRows.length).toBe(3);

    // Row 1: 已用
    expect(statRows[0].textContent).toContain("已用");
    expect(statRows[0].textContent).toContain("116,234 tokens");

    // Row 2: 总量
    expect(statRows[1].textContent).toContain("总量");
    expect(statRows[1].textContent).toContain("1,000,000 tokens");

    // Row 3: 剩余可用 = 1,000,000 - 116,234 = 883,766
    expect(statRows[2].textContent).toContain("剩余可用");
    expect(statRows[2].textContent).toContain("883,766 tokens");

    // Must not show cost anywhere in popover
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).not.toContain("cost");
    expect(container.textContent).not.toContain("费用");
  });

  it("handles undefined or invalid usage gracefully without NaN or crashing", () => {
    const { container } = createPopover({
      contextUsage: undefined,
    });

    const percentage = container.querySelector(
      ".hermesian-context-popover-percentage",
    );
    expect(percentage?.textContent).toBe("0%");
    expect(container.dataset.level).toBe("normal");

    const statRows = container.querySelectorAll(
      ".hermesian-context-popover-stat-row",
    );
    expect(statRows[0].textContent).toContain("0 tokens");
    expect(statRows[1].textContent).toContain("—");
    expect(statRows[2].textContent).toContain("—");
    expect(container.textContent).not.toContain("NaN");
  });

  it("renders compress button with fold-vertical icon and triggers onCompress and closes on click", () => {
    const { container, onCompress, popover, iconRenderer } = createPopover();
    const btn = container.querySelector(
      ".hermesian-context-popover-compress-btn",
    ) as HTMLButtonElement;

    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("压缩上下文");
    expect(iconRenderer).toHaveBeenCalledWith(expect.any(HTMLElement), "fold-vertical");

    btn.click();
    expect(onCompress).toHaveBeenCalledOnce();
    expect(popover.isOpen()).toBe(false);
    expect(document.body.querySelector(".hermesian-context-popover")).toBeNull();
  });

  it("disables compress button when canCompress is unavailable with reason tooltip", () => {
    const { container, onCompress, popover } = createPopover({
      canCompress: { available: false, reason: "会话正忙，请稍候…" },
    });
    const btn = container.querySelector(
      ".hermesian-context-popover-compress-btn",
    ) as HTMLButtonElement;

    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toBe("会话正忙，请稍候…");

    btn.click();
    expect(onCompress).not.toHaveBeenCalled();
    expect(popover.isOpen()).toBe(true);
  });

  it("detaches on Escape key and returns focus to anchor", () => {
    const { popover, onClose } = createPopover();
    const focusSpy = vi.spyOn(anchor, "focus");

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escapeEvent);

    expect(popover.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(focusSpy).toHaveBeenCalled();
  });

  it("detaches on click outside", () => {
    const { popover, onClose } = createPopover();
    const outsideEl = document.createElement("div");
    document.body.appendChild(outsideEl);

    const pointerEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    outsideEl.dispatchEvent(pointerEvent);

    expect(popover.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not detach on pointerdown on anchor element", () => {
    const { popover } = createPopover();

    const pointerEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(pointerEvent);

    // Should remain open after pointerdown on anchor so the subsequent click can toggle
    expect(popover.isOpen()).toBe(true);
  });

  it("updates data dynamically when update() is called", () => {
    const { container, popover } = createPopover({
      contextUsage: { used: 50_000, size: 1_000_000 },
      canCompress: { available: true },
    });

    const percentage = container.querySelector(
      ".hermesian-context-popover-percentage",
    );
    expect(percentage?.textContent).toBe("5%");

    // Update with new usage & busy state
    popover.update(
      { used: 920_000, size: 1_000_000 },
      { available: false, reason: "会话正忙，请稍候…" },
    );

    expect(percentage?.textContent).toBe("92%");
    expect(container.dataset.level).toBe("danger");

    const btn = container.querySelector(
      ".hermesian-context-popover-compress-btn",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("会话正忙，请稍候…");
  });
});
