/**
 * Shared anchored-popover geometry for the composer pickers (model + thinking
 * depth). Both popovers open upward from their anchor button, so the arithmetic
 * lives here once instead of being duplicated per popover.
 *
 * Width semantics (approved product decision): the popover follows the
 * **sidebar's content width**, not the anchor button's width, and never spills
 * out of the sidebar. Different pickers are *not* required to be equally wide;
 * they simply share this one formula. The two trigger buttons are deliberately
 * different widths (the model button is `flex: 1 1 0`, the thinking-depth button
 * is `0 1 155px`), so any anchor-following formula could never produce a panel
 * that fits a manually narrowed sidebar — and `window.innerWidth`-based overflow
 * protection is useless in the real "wide Obsidian window + manually narrowed
 * sidebar" case, which is exactly the bug users reported. The old 240px floor is
 * gone: a sidebar narrower than 256px now yields a correspondingly narrower
 * panel instead of one that overflows the sidebar.
 */

export const PICKER_WIDTH_MAX = 360;
export const PICKER_EDGE_PADDING = 8;
export const PICKER_GAP_ABOVE_ANCHOR = 8;

export interface PickerPlacementInput {
  /** Vertical anchor only: the panel grows upward from the button's top edge. */
  anchorRect: { top: number };
  /** The sidebar content box (`.hermesian-view`) in viewport coordinates. */
  containerRect: { left: number; width: number };
  viewport: { height: number; width: number };
  popoverHeightMax: number;
}

export interface PickerPlacement {
  bottom: number;
  height: number;
  left: number;
  width: number;
}

/**
 * Clamp `value` into `[lo, hi]`. When the range is inverted (`hi < lo`) the
 * lower bound wins, which is the documented tie-break for this module.
 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

/**
 * Pure: computes the anchored popover box. Must be testable without DOM.
 *
 * - `width` follows the sidebar content width (capped at `PICKER_WIDTH_MAX`)
 *   and is never negative, so the panel never spills past the sidebar edge. No
 *   equal-width guarantee between pickers is implied: they only share this
 *   formula, and width is independent of the trigger button's width.
 * - `left` hugs the sidebar's left edge plus edge padding, clamped so the panel
 *   never passes the viewport's right edge.
 * - `height` is the max-height: never taller than the space between the anchor
 *   and the viewport top (no floor, so a near-top anchor shrinks the panel
 *   instead of pushing it out of bounds).
 * - `bottom` pins the panel just above the anchor.
 */
export function resolvePickerPlacement(input: PickerPlacementInput): PickerPlacement {
  const { anchorRect, containerRect, viewport, popoverHeightMax } = input;
  // Sidebar content width minus symmetric edge padding; `max(0, ...)` keeps the
  // result non-negative for a degenerate (0 or negative) container width.
  const width = Math.max(
    0,
    Math.min(PICKER_WIDTH_MAX, containerRect.width - PICKER_EDGE_PADDING * 2),
  );
  // Hug the sidebar's left edge (never the screen's left edge), clamped into
  // `[max(8, containerLeft + 8), viewport.width - width - 8]`. For a sidebar
  // that is fully on screen the two bounds can never invert (the panel is
  // derived from the sidebar width, so it always fits); the lower bound
  // additionally rescues a container rect that starts left of the viewport.
  const leftFloor = Math.max(
    PICKER_EDGE_PADDING,
    containerRect.left + PICKER_EDGE_PADDING,
  );
  const left = clamp(
    containerRect.left + PICKER_EDGE_PADDING,
    leftFloor,
    viewport.width - width - PICKER_EDGE_PADDING,
  );
  const height = Math.min(
    popoverHeightMax,
    Math.max(0, anchorRect.top - PICKER_GAP_ABOVE_ANCHOR - PICKER_EDGE_PADDING),
  );
  const bottom = viewport.height - anchorRect.top + PICKER_GAP_ABOVE_ANCHOR;
  return { bottom, height, left, width };
}
