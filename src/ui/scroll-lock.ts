/**
 * Per-tab auto-scroll follow lock for streaming chat surfaces.
 *
 * Scroll events drive lock/unlock; no polling. When the user scrolls away from
 * the bottom beyond `thresholdPx`, auto-follow freezes until they return near
 * the bottom or an explicit unlock (e.g. sending a new message) occurs.
 */

export const DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX = 32;

export interface ScrollGeometry {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export function distanceFromBottom(geometry: ScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop);
}

export function isNearBottom(
  geometry: ScrollGeometry,
  thresholdPx: number = DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(geometry) <= thresholdPx;
}

export function readScrollGeometry(el: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">): ScrollGeometry {
  return {
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
  };
}

/**
 * Pure state store: follow is sticky per tab. Defaults to following (unlocked).
 * `locked === true` means auto-scroll-to-bottom is frozen for that tab.
 */
export class ScrollFollowController {
  readonly #lockedByTab = new Map<string, boolean>();
  readonly #thresholdPx: number;

  constructor(thresholdPx: number = DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX) {
    this.#thresholdPx = thresholdPx;
  }

  get thresholdPx(): number {
    return this.#thresholdPx;
  }

  /** True when auto-follow is active (not frozen). Unknown tabs follow. */
  isFollowing(tabId: string): boolean {
    return this.#lockedByTab.get(tabId) !== true;
  }

  /** True when auto-follow is frozen for the tab. */
  isLocked(tabId: string): boolean {
    return this.#lockedByTab.get(tabId) === true;
  }

  lock(tabId: string): void {
    this.#lockedByTab.set(tabId, true);
  }

  unlock(tabId: string): void {
    this.#lockedByTab.set(tabId, false);
  }

  /** Drop state when a tab is removed. */
  forget(tabId: string): void {
    this.#lockedByTab.delete(tabId);
  }

  /**
   * Update lock from a user scroll (or programmatic scroll that should be
   * treated as user intent). Near-bottom → unlock; far from bottom → lock.
   */
  syncFromGeometry(tabId: string, geometry: ScrollGeometry): void {
    if (isNearBottom(geometry, this.#thresholdPx)) {
      this.unlock(tabId);
    } else {
      this.lock(tabId);
    }
  }

  /**
   * Whether a streaming auto-scroll should run for `sourceTabId` on the
   * currently visible tab. Unscoped (no source) scrolls only when the visible
   * tab is following.
   */
  shouldAutoScroll(visibleTabId: string | undefined, sourceTabId?: string): boolean {
    if (sourceTabId !== undefined && visibleTabId !== undefined && sourceTabId !== visibleTabId) {
      return false;
    }
    const tabId = sourceTabId ?? visibleTabId;
    if (tabId === undefined) {
      return true;
    }
    return this.isFollowing(tabId);
  }
}
