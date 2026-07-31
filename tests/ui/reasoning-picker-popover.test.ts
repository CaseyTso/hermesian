// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HermesReasoningPickerPopover,
  type HermesReasoningPickerOptions,
  reasoningEffortDescription,
} from "../../src/ui/reasoning-picker-popover";
import { REASONING_EFFORTS } from "../../src/session-history";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 630,
    height: 30,
    left: 500,
    right: 655,
    top: 600,
    width: 155,
    x: 500,
    y: 600,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("reasoning picker helpers", () => {
  it("returns a description for every supported effort", () => {
    expect(REASONING_EFFORTS.map(reasoningEffortDescription).every(Boolean)).toBe(
      true,
    );
  });
});

describe("HermesReasoningPickerPopover", () => {
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

  function openPopover(overrides: Partial<HermesReasoningPickerOptions> = {}) {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    const iconRenderer = vi.fn((element: HTMLElement, icon: string) => {
      element.dataset.icon = icon;
    });
    const picker = new HermesReasoningPickerPopover({
      anchorEl: anchor,
      current: "xhigh",
      efforts: REASONING_EFFORTS,
      getViewport: () => ({ height: 768, width: 1024 }),
      iconRenderer,
      onChoose,
      onClose,
      ...overrides,
    });
    picker.open();
    return {
      container: document.body.querySelector(
        ".hermesian-reasoning-popover",
      ) as HTMLElement,
      iconRenderer,
      onChoose,
      onClose,
      picker,
    };
  }

  it("opens in document.body with no search controls and focuses the listbox", () => {
    const { container, picker } = openPopover();
    expect(container.getAttribute("role")).toBe("dialog");
    expect(anchor.getAttribute("aria-haspopup")).toBe("listbox");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("input")).toBeNull();
    expect(
      container.querySelector(".hermesian-reasoning-popover-search"),
    ).toBeNull();
    expect(container.querySelector("[role=combobox]")).toBeNull();
    expect(
      container.querySelector(".hermesian-reasoning-popover-empty"),
    ).toBeNull();
    const list = container.querySelector(
      ".hermesian-reasoning-popover-list",
    ) as HTMLElement;
    expect(list.getAttribute("role")).toBe("listbox");
    expect(document.activeElement).toBe(list);
    expect(picker.isOpen()).toBe(true);
  });

  it("keeps title and close button in one header row, list follows directly", () => {
    const { container } = openPopover();
    const header = container.querySelector(
      ".hermesian-reasoning-popover-header",
    ) as HTMLElement;
    expect(header).toBeTruthy();
    const title = header.querySelector(".hermesian-reasoning-popover-title");
    expect(title?.textContent).toBe("THINKING DEPTH");
    expect(
      header.querySelector(".hermesian-reasoning-popover-close-button"),
    ).toBeTruthy();
    const list = container.querySelector(
      ".hermesian-reasoning-popover-list",
    ) as HTMLElement;
    expect(list.querySelector(".hermesian-reasoning-popover-title")).toBeNull();
    expect(container.querySelector(".hermesian-reasoning-group-label")).toBeNull();
    const rows = [
      ...list.querySelectorAll<HTMLElement>(".hermesian-reasoning-option"),
    ];
    expect(rows).toHaveLength(REASONING_EFFORTS.length);
    expect(
      rows.map(
        (row) =>
          row.querySelector(".hermesian-reasoning-option-name")?.textContent,
      ),
    ).toEqual([
      "Provider default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("renders all efforts in order and marks xhigh current", () => {
    const { container } = openPopover();
    const rows = [
      ...container.querySelectorAll<HTMLElement>(
        ".hermesian-reasoning-option",
      ),
    ];
    expect(rows).toHaveLength(REASONING_EFFORTS.length);
    expect(
      rows.map(
        (row) =>
          row.querySelector(".hermesian-reasoning-option-name")?.textContent,
      ),
    ).toEqual([
      "Provider default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    const current = rows.find(
      (row) => row.getAttribute("aria-selected") === "true",
    );
    expect(current?.textContent).toContain("xhigh");
    expect(current?.textContent).toContain("Current");
    expect(current?.querySelector("[data-icon=check]")).toBeTruthy();
    expect(current?.classList.contains("is-active")).toBe(true);
  });

  it("anchors above the button and caps its dimensions", async () => {
    const { container } = openPopover();
    await sleep(30);
    expect(container.style.width).toBe("240px");
    expect(container.style.left).toBe("500px");
    expect(container.style.bottom).toBe("176px");
    expect(container.style.maxHeight).toBe("420px");
  });

  it("never crosses the top edge when little space is available", () => {
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      rect({ top: 40, bottom: 70 }),
    );
    const { container } = openPopover();
    const maxHeight = Number.parseFloat(container.style.maxHeight);
    const bottom = Number.parseFloat(container.style.bottom);
    expect(maxHeight).toBe(24);
    expect(768 - bottom - maxHeight).toBeGreaterThanOrEqual(8);
  });

  it("clamps both horizontal edges in a 300px viewport", () => {
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      rect({ left: 270, right: 425 }),
    );
    const { container } = openPopover({
      getViewport: () => ({ height: 768, width: 300 }),
    });
    const left = Number.parseFloat(container.style.left);
    const width = Number.parseFloat(container.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(292);
  });

  it("repositions after resize", () => {
    const viewport = { height: 768, width: 1024 };
    const { container } = openPopover({ getViewport: () => viewport });
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
      rect({ left: 500, right: 655, top: 100, bottom: 130 }),
    );
    viewport.width = 600;
    window.dispatchEvent(new Event("resize"));
    expect(container.style.left).toBe("352px");
    expect(container.style.maxHeight).toBe("84px");
  });

  it("uses arrow keys and Enter to choose exactly once without a search box", () => {
    const { container, onChoose, picker } = openPopover();
    container.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      }),
    );
    container.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("max");
    expect(picker.isOpen()).toBe(false);
    container.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
    );
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("clicking the current row still settles once and closes", () => {
    const { container, onChoose, picker } = openPopover();
    const current = [
      ...container.querySelectorAll<HTMLElement>(
        ".hermesian-reasoning-option",
      ),
    ].find((row) => row.getAttribute("aria-selected") === "true")!;
    current.click();
    current.click();
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("xhigh");
    expect(picker.isOpen()).toBe(false);
  });

  it("Escape closes, restores focus and removes listeners", () => {
    const { container, onClose, picker } = openPopover();
    container.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    expect(picker.isOpen()).toBe(false);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(anchor);
    expect(onClose).toHaveBeenCalledTimes(1);
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    window.dispatchEvent(new Event("resize"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close button closes the popover and restores anchor focus", () => {
    const { container, onClose, picker } = openPopover();
    (
      container.querySelector(
        ".hermesian-reasoning-popover-close-button",
      ) as HTMLElement
    ).click();
    expect(picker.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("outside pointerdown closes while inside pointerdown does not", () => {
    const { container, onClose } = openPopover();
    (container.querySelector(
      ".hermesian-reasoning-option",
    ) as HTMLElement).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    expect(document.body.contains(container)).toBe(true);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.body.contains(container)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("respects reduced motion and removes the body marker on detach", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
    const { picker } = openPopover();
    expect(document.body.classList.contains("hermesian-reduced-motion")).toBe(
      true,
    );
    picker.detach();
    expect(document.body.classList.contains("hermesian-reduced-motion")).toBe(
      false,
    );
  });
});
