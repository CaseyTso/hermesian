// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HermesModelPickerPopover } from "../../src/ui/model-picker-popover";
import { HermesReasoningPickerPopover } from "../../src/ui/reasoning-picker-popover";
import { REASONING_EFFORTS } from "../../src/session-history";
import type { HermesModelOption } from "../../src/types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 630,
    height: 30,
    left: 620,
    right: 775,
    top: 600,
    width: 155,
    x: 620,
    y: 600,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

const MODELS: HermesModelOption[] = [
  {
    description: "",
    modelId: "gpt-4o",
    name: "GPT-4o",
    providerId: "openai",
    providerName: "OpenAI",
    switchId: "openai:gpt-4o",
  },
];

/**
 * The original bug: the two pickers were sized from their own anchor buttons,
 * which are deliberately different widths in the composer (`flex: 1 1 0` vs
 * `0 1 155px`), so a manually narrowed sidebar produced a panel that spilled
 * past the sidebar edge.
 *
 * This suite asserts the surviving product requirement: each picker's width is
 * bounded by the sidebar content box (never the trigger button, never the
 * window) and never overflows the sidebar/viewport. The two pickers are NOT
 * required to be equally wide — they merely share one formula, so for the same
 * sidebar they happen to resolve the same numbers. That equality is recorded
 * below as evidence of the shared formula, not as a product requirement.
 */
describe("model + reasoning picker width bounds", () => {
  let modelAnchor: HTMLButtonElement;
  let reasoningAnchor: HTMLButtonElement;
  const viewport = { height: 768, width: 1024 };
  // Wide window, narrow sidebar — the scenario that broke the old formula.
  const containerRect = { left: 620, width: 300 };

  beforeEach(() => {
    modelAnchor = document.createElement("button");
    reasoningAnchor = document.createElement("button");
    document.body.append(modelAnchor, reasoningAnchor);
    // Model button: full-width flex child.
    vi.spyOn(modelAnchor, "getBoundingClientRect").mockReturnValue(rect({ width: 300, right: 920 }));
    // Thinking button: narrow fixed-ish button.
    vi.spyOn(reasoningAnchor, "getBoundingClientRect").mockReturnValue(
      rect({ width: 90, right: 710 }),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function openBoth(container: { left: number; width: number } = containerRect): {
    model: HTMLElement;
    reasoning: HTMLElement;
  } {
    const modelPicker = new HermesModelPickerPopover({
      anchorEl: modelAnchor,
      currentSwitchId: "openai:gpt-4o",
      hiddenSwitchIds: [],
      models: MODELS,
      onChoose: () => {},
      onSaveHidden: () => {},
      getViewport: () => viewport,
      getContainerRect: () => container,
    });
    const reasoningPicker = new HermesReasoningPickerPopover({
      anchorEl: reasoningAnchor,
      current: "xhigh",
      efforts: REASONING_EFFORTS,
      onChoose: () => {},
      getViewport: () => viewport,
      getContainerRect: () => container,
    });
    modelPicker.open();
    reasoningPicker.open();
    return {
      model: document.body.querySelector(".hermesian-model-popover") as HTMLElement,
      reasoning: document.body.querySelector(".hermesian-reasoning-popover") as HTMLElement,
    };
  }

  /** Both popovers stay inside the sidebar and the viewport. */
  function expectNoOverflow(
    el: HTMLElement,
    container: { left: number; width: number },
  ): void {
    const left = Number.parseFloat(el.style.left);
    const width = Number.parseFloat(el.style.width);
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(width)).toBe(true);
    // Never spills past the viewport's right edge (8px edge padding kept).
    expect(left + width + 8).toBeLessThanOrEqual(viewport.width);
    // Hugs the sidebar's left edge plus padding.
    expect(left).toBeGreaterThanOrEqual(container.left + 8);
    // Entirely inside the sidebar's content box.
    expect(left + width).toBeLessThanOrEqual(container.left + container.width);
  }

  it("keeps both popovers inside the sidebar despite different anchor widths", async () => {
    const { model, reasoning } = openBoth();
    await sleep(30);

    expect(model.style.width).not.toBe("");
    expect(reasoning.style.width).not.toBe("");
    expectNoOverflow(model, containerRect);
    expectNoOverflow(reasoning, containerRect);

    // Width is derived from the sidebar alone: 300px minus 2 x 8px padding.
    expect(model.style.width).toBe("284px");
    expect(reasoning.style.width).toBe("284px");
    // Sidebar left edge + padding, not the screen edge.
    expect(model.style.left).toBe("628px");
  });

  it("is unchanged when the anchor widths are swapped", async () => {
    // Sanity check that the bound is not an artifact of which anchor is wider.
    vi.spyOn(modelAnchor, "getBoundingClientRect").mockReturnValue(rect({ width: 90, right: 710 }));
    vi.spyOn(reasoningAnchor, "getBoundingClientRect").mockReturnValue(
      rect({ width: 300, right: 920 }),
    );
    const { model, reasoning } = openBoth();
    await sleep(30);

    expectNoOverflow(model, containerRect);
    expectNoOverflow(reasoning, containerRect);
    expect(model.style.width).toBe("284px");
    expect(reasoning.style.width).toBe("284px");
  });

  it("ignores absurd anchor widths entirely (a 900px trigger cannot widen the panel)", async () => {
    // The trigger button is a composer control, never a width input.
    vi.spyOn(modelAnchor, "getBoundingClientRect").mockReturnValue(
      rect({ width: 900, right: 1520 }),
    );
    vi.spyOn(reasoningAnchor, "getBoundingClientRect").mockReturnValue(
      rect({ width: 12, right: 632 }),
    );
    const { model, reasoning } = openBoth();
    await sleep(30);

    expectNoOverflow(model, containerRect);
    expectNoOverflow(reasoning, containerRect);
    expect(model.style.width).toBe("284px");
    expect(reasoning.style.width).toBe("284px");
  });

  it("keeps both pickers inside a 200px sidebar", async () => {
    const narrow = { left: 620, width: 200 };
    const { model, reasoning } = openBoth(narrow);
    await sleep(30);

    // 200px sidebar minus 2 x 8px padding: the panel follows the sidebar
    // instead of overflowing it (no 240px floor pushing it past the edge).
    expect(model.style.width).toBe("184px");
    expect(reasoning.style.width).toBe("184px");
    expectNoOverflow(model, narrow);
    expectNoOverflow(reasoning, narrow);
  });

  it("caps both pickers at 360px in a 1000px sidebar", async () => {
    const wide = { left: 620, width: 1000 };
    const { model, reasoning } = openBoth(wide);
    await sleep(30);

    expect(model.style.width).toBe("360px");
    expect(reasoning.style.width).toBe("360px");
    expectNoOverflow(model, wide);
    expectNoOverflow(reasoning, wide);
  });

  it("falls back to the whole viewport when no container rect is provided", async () => {
    const modelPicker = new HermesModelPickerPopover({
      anchorEl: modelAnchor,
      currentSwitchId: "openai:gpt-4o",
      hiddenSwitchIds: [],
      models: MODELS,
      onChoose: () => {},
      onSaveHidden: () => {},
      getViewport: () => viewport,
    });
    const reasoningPicker = new HermesReasoningPickerPopover({
      anchorEl: reasoningAnchor,
      current: "xhigh",
      efforts: REASONING_EFFORTS,
      onChoose: () => {},
      getViewport: () => viewport,
    });
    modelPicker.open();
    reasoningPicker.open();
    await sleep(30);

    const model = document.body.querySelector(".hermesian-model-popover") as HTMLElement;
    const reasoning = document.body.querySelector(".hermesian-reasoning-popover") as HTMLElement;
    // viewport.width 1024 -> capped at 360 for both.
    expect(model.style.width).toBe("360px");
    expect(reasoning.style.width).toBe("360px");
    expect(model.style.left).toBe("8px");
    expect(reasoning.style.left).toBe("8px");
    expectNoOverflow(model, { left: 0, width: viewport.width });
    expectNoOverflow(reasoning, { left: 0, width: viewport.width });
  });

  it("resolves identical numbers for the same sidebar as a side effect of one shared formula", async () => {
    // NOT a product requirement: the pickers are not mandated to be equally
    // wide. They only share `resolvePickerPlacement`, so identical inputs
    // produce identical outputs. This assertion exists to catch a regression
    // where one picker stops using the shared formula.
    const { model, reasoning } = openBoth();
    await sleep(30);

    expect(model.style.width).toBe(reasoning.style.width);
    expect(model.style.left).toBe(reasoning.style.left);
  });
});
