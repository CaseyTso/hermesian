import { describe, expect, it } from "vitest";

import {
  PICKER_EDGE_PADDING,
  PICKER_GAP_ABOVE_ANCHOR,
  PICKER_GAP_BELOW_ANCHOR,
  PICKER_WIDTH_MAX,
  resolveAnchoredDownwardPlacement,
  resolveDownwardPickerPlacement,
  resolvePickerPlacement,
} from "../src/ui/picker-geometry";

const MODEL_HEIGHT_MAX = 480;
const REASONING_HEIGHT_MAX = 420;

function place(
  containerRect: { left: number; width: number },
  viewport: { height: number; width: number },
  popoverHeightMax: number,
  anchorTop = 600,
) {
  return resolvePickerPlacement({
    anchorRect: { top: anchorTop },
    containerRect,
    viewport,
    popoverHeightMax,
  });
}

describe("resolvePickerPlacement — width follows the sidebar", () => {
  it("resolves the same width and left for the same sidebar as a side effect of the shared formula; only height differs", () => {
    // Not an equal-width mandate: the pickers merely share this one formula, so
    // identical inputs produce identical outputs. The only input that differs
    // is popoverHeightMax.
    const containerRect = { left: 620, width: 300 };
    const viewport = { height: 768, width: 1024 };
    const model = place(containerRect, viewport, MODEL_HEIGHT_MAX);
    const reasoning = place(containerRect, viewport, REASONING_HEIGHT_MAX);

    expect(model.width).toBe(reasoning.width);
    expect(model.left).toBe(reasoning.left);
    expect(model.bottom).toBe(reasoning.bottom);
    expect(model.height).toBe(MODEL_HEIGHT_MAX);
    expect(reasoning.height).toBe(REASONING_HEIGHT_MAX);
    expect(model.height).not.toBe(reasoning.height);
  });

  it("does not depend on the anchor button width at all (anchorRect carries only top)", () => {
    // The trigger buttons are deliberately different widths (model `flex: 1 1 0`
    // vs thinking `0 1 155px`); the geometry input has no width field, so width
    // is bounded by the sidebar alone and can never overflow it.
    const containerRect = { left: 0, width: 300 };
    const viewport = { height: 768, width: 1024 };
    const a = place(containerRect, viewport, MODEL_HEIGHT_MAX);
    const b = place(containerRect, viewport, MODEL_HEIGHT_MAX);
    expect(a.width).toBe(b.width);
    expect(a.left).toBe(b.left);
  });

  it("yields 184px in a 200px sidebar and stays inside the viewport (no overflow)", () => {
    // The approved core win: a narrowed sidebar no longer produces an
    // overflowing panel, and there is no 240px floor pushing it past the edge.
    const containerRect = { left: 0, width: 200 };
    const viewport = { height: 768, width: 1024 };
    const placement = place(containerRect, viewport, MODEL_HEIGHT_MAX);

    expect(placement.width).toBe(184);
    expect(placement.left + placement.width + PICKER_EDGE_PADDING).toBeLessThanOrEqual(
      viewport.width,
    );
    // ... and it is entirely inside the sidebar itself.
    expect(placement.left + placement.width).toBeLessThanOrEqual(
      containerRect.left + containerRect.width,
    );
  });

  it("caps at 360px in a 1000px sidebar", () => {
    const placement = place({ left: 0, width: 1000 }, { height: 768, width: 1024 }, MODEL_HEIGHT_MAX);
    expect(placement.width).toBe(PICKER_WIDTH_MAX);
    expect(placement.width).toBe(360);
  });

  it("never returns a negative width for an absurdly narrow (16px) sidebar", () => {
    const placement = place({ left: 0, width: 16 }, { height: 768, width: 1024 }, MODEL_HEIGHT_MAX);
    expect(placement.width).toBeGreaterThanOrEqual(0);
    expect(placement.width).toBe(0);
    // A degenerate container width must not throw off the horizontal anchor.
    expect(placement.left).toBe(PICKER_EDGE_PADDING);
  });

  it("hugs the sidebar's left edge when the sidebar sits on the right of the screen", () => {
    const containerRect = { left: 400, width: 300 };
    const placement = place(containerRect, { height: 768, width: 1024 }, MODEL_HEIGHT_MAX);
    // Sidebar edge + padding, not the screen edge (8).
    expect(placement.left).toBeGreaterThanOrEqual(containerRect.left + PICKER_EDGE_PADDING);
    expect(placement.left).toBe(408);
  });
});

describe("resolvePickerPlacement — vertical logic is unchanged", () => {
  it("never returns a negative height when the anchor sits at the viewport top", () => {
    const placement = place({ left: 0, width: 300 }, { height: 768, width: 1024 }, MODEL_HEIGHT_MAX, 10);
    expect(placement.height).toBeGreaterThanOrEqual(0);
    expect(placement.height).toBe(0);
  });

  it("caps the height at each picker's own max and shrinks it near the top edge", () => {
    const containerRect = { left: 0, width: 300 };
    const viewport = { height: 768, width: 1024 };
    expect(place(containerRect, viewport, MODEL_HEIGHT_MAX, 600).height).toBe(480);
    expect(place(containerRect, viewport, REASONING_HEIGHT_MAX, 600).height).toBe(420);
    // 100 - 8 (gap) - 8 (edge padding) = 84
    expect(place(containerRect, viewport, MODEL_HEIGHT_MAX, 100).height).toBe(84);
  });

  it("pins the bottom just above the anchor", () => {
    const viewport = { height: 768, width: 1024 };
    const containerRect = { left: 0, width: 300 };
    const placement = place(containerRect, viewport, MODEL_HEIGHT_MAX, 600);
    expect(placement.bottom).toBe(viewport.height - 600 + PICKER_GAP_ABOVE_ANCHOR);
    expect(placement.bottom).toBe(176);
    expect(placement.bottom).toBe(place(containerRect, viewport, REASONING_HEIGHT_MAX, 600).bottom);
  });
});

describe("resolveDownwardPickerPlacement", () => {
  const TITLE_POPOVER_HEIGHT_MAX = 320;

  function placeDownward(
    containerRect: { left: number; width: number },
    viewport: { height: number; width: number },
    anchorBottom = 40,
    popoverHeightMax = TITLE_POPOVER_HEIGHT_MAX,
  ) {
    return resolveDownwardPickerPlacement({
      anchorRect: { bottom: anchorBottom },
      containerRect,
      viewport,
      popoverHeightMax,
    });
  }

  it("shares the same width and left calculation as resolvePickerPlacement", () => {
    const containerRect = { left: 400, width: 300 };
    const viewport = { height: 768, width: 1024 };
    const downward = placeDownward(containerRect, viewport, 50);
    const upward = resolvePickerPlacement({
      anchorRect: { top: 600 },
      containerRect,
      viewport,
      popoverHeightMax: TITLE_POPOVER_HEIGHT_MAX,
    });

    expect(downward.width).toBe(upward.width);
    expect(downward.left).toBe(upward.left);
  });

  it("positions top at anchorRect.bottom + PICKER_GAP_BELOW_ANCHOR", () => {
    const containerRect = { left: 0, width: 300 };
    const viewport = { height: 768, width: 1024 };
    const downward = placeDownward(containerRect, viewport, 44);

    expect(downward.top).toBe(44 + PICKER_GAP_BELOW_ANCHOR);
    expect(downward.top).toBe(52);
  });

  it("caps the height at popoverHeightMax when there is ample vertical space", () => {
    const containerRect = { left: 0, width: 300 };
    const viewport = { height: 768, width: 1024 };
    const downward = placeDownward(containerRect, viewport, 40, 320);

    expect(downward.height).toBe(320);
  });

  it("shrinks height when anchor is near the bottom of viewport and avoids overflow", () => {
    const containerRect = { left: 0, width: 300 };
    const viewport = { height: 768, width: 1024 };
    // top = 700 + 8 = 708. Available = 768 - 708 - 8 = 52.
    const downward = placeDownward(containerRect, viewport, 700, 320);

    expect(downward.height).toBe(52);
    expect(downward.top + downward.height + PICKER_EDGE_PADDING).toBeLessThanOrEqual(viewport.height);
  });

  it("never returns a negative height if anchor is beyond the viewport bottom", () => {
    const containerRect = { left: 0, width: 300 };
    const viewport = { height: 768, width: 1024 };
    const downward = placeDownward(containerRect, viewport, 800, 320);

    expect(downward.height).toBe(0);
  });
});

describe("resolveAnchoredDownwardPlacement (context gauge popover)", () => {
  it("uses custom popover width and centers horizontally under the anchor when space permits", () => {
    const containerRect = { left: 100, width: 400 };
    const viewport = { height: 768, width: 1024 };
    const anchorRect = { bottom: 40, left: 280, right: 320 }; // center = 300

    const placement = resolveAnchoredDownwardPlacement({
      anchorRect,
      containerRect,
      viewport,
      popoverWidth: 260,
      popoverHeightMax: 320,
    });

    expect(placement.width).toBe(260);
    // idealLeft = 300 - 130 = 170.
    // minLeft = 100 + 8 = 108. maxLeft = 100 + 400 - 260 - 8 = 232.
    // 170 is in [108, 232].
    expect(placement.left).toBe(170);
    // arrow points to anchorCenter (300) -> 300 - 170 = 130
    expect(placement.arrowOffsetLeft).toBe(130);
    expect(placement.top).toBe(48);
    expect(placement.height).toBe(320);
  });

  it("clamps to right boundary of sidebar and shifts arrow offset accordingly", () => {
    const containerRect = { left: 100, width: 300 };
    const viewport = { height: 768, width: 1024 };
    // Anchor near the right edge of the sidebar
    const anchorRect = { bottom: 40, left: 360, right: 390 }; // center = 375

    const placement = resolveAnchoredDownwardPlacement({
      anchorRect,
      containerRect,
      viewport,
      popoverWidth: 260,
      popoverHeightMax: 320,
    });

    expect(placement.width).toBe(260);
    // maxLeft = 100 + 300 - 260 - 8 = 132.
    expect(placement.left).toBe(132);
    // arrowOffset = 375 - 132 = 243. Clamped to [16, 260 - 16 = 244].
    expect(placement.arrowOffsetLeft).toBe(243);
  });

  it("clamps to left boundary of sidebar when anchor is near left edge", () => {
    const containerRect = { left: 100, width: 300 };
    const viewport = { height: 768, width: 1024 };
    // Anchor near the left edge
    const anchorRect = { bottom: 40, left: 105, right: 125 }; // center = 115

    const placement = resolveAnchoredDownwardPlacement({
      anchorRect,
      containerRect,
      viewport,
      popoverWidth: 260,
      popoverHeightMax: 320,
    });

    expect(placement.width).toBe(260);
    // minLeft = 100 + 8 = 108.
    expect(placement.left).toBe(108);
    // arrowOffset = 115 - 108 = 7, clamped to min padding 16.
    expect(placement.arrowOffsetLeft).toBe(16);
  });

  it("narrows width when sidebar is narrower than desired popover width", () => {
    const containerRect = { left: 0, width: 200 };
    const viewport = { height: 768, width: 1024 };
    const anchorRect = { bottom: 40, left: 170, right: 190 }; // center = 180

    const placement = resolveAnchoredDownwardPlacement({
      anchorRect,
      containerRect,
      viewport,
      popoverWidth: 260,
      popoverHeightMax: 320,
    });

    // 200 - 16 = 184
    expect(placement.width).toBe(184);
    expect(placement.left + placement.width + 8).toBeLessThanOrEqual(200);
  });
});
