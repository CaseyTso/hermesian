/**
 * Per-tab auto-scroll follow lock for streaming chat surfaces.
 *
 * Scroll events drive lock/unlock; no polling. When the user scrolls away from
 * the bottom beyond `thresholdPx`, auto-follow freezes until they return near
 * the bottom or an explicit unlock (e.g. sending a new message) occurs.
 */

export const DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX = 40;
export const DEFAULT_SCROLL_COOLDOWN_MS = 150;

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

export interface SyncGeometryOptions {
  /**
   * True when the geometry sync is driven by explicit user scroll intent.
   * Explicit user scrolls to near-bottom bypass the 150ms cooldown and unlock immediately.
   */
  userInitiated?: boolean;
}

export interface ScrollFollowControllerOptions {
  thresholdPx?: number;
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Pure state store: follow is sticky per tab. Defaults to following (unlocked).
 * `locked === true` means auto-scroll-to-bottom is frozen for that tab.
 */
export class ScrollFollowController {
  readonly #lockedByTab = new Map<string, boolean>();
  readonly #lastDistanceByTab = new Map<string, number>();
  readonly #lastUserScrollAwayAtByTab = new Map<string, number>();
  readonly #thresholdPx: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(options: ScrollFollowControllerOptions = {}) {
    this.#thresholdPx = options.thresholdPx ?? DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_SCROLL_COOLDOWN_MS;
    this.#now = options.now ?? Date.now;
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
    this.#lastUserScrollAwayAtByTab.delete(tabId);
    this.#lastDistanceByTab.delete(tabId);
  }

  /** Drop state when a tab is removed. */
  forget(tabId: string): void {
    this.#lockedByTab.delete(tabId);
    this.#lastUserScrollAwayAtByTab.delete(tabId);
    this.#lastDistanceByTab.delete(tabId);
  }

  /**
   * Update lock from a user scroll (or programmatic scroll that should be
   * treated as user intent). Near-bottom → unlock; far from bottom → lock.
   */
  syncFromGeometry(
    tabId: string,
    geometry: ScrollGeometry,
    options?: SyncGeometryOptions | boolean,
  ): void {
    const userInitiated =
      typeof options === "boolean"
        ? options
        : Boolean(options?.userInitiated);

    const dist = distanceFromBottom(geometry);
    const prevDist = this.#lastDistanceByTab.get(tabId);
    this.#lastDistanceByTab.set(tabId, dist);

    const wasLocked = this.isLocked(tabId);
    if (dist > this.#thresholdPx) {
      this.lock(tabId);
      if (!wasLocked || prevDist === undefined || dist > prevDist) {
        this.#lastUserScrollAwayAtByTab.set(tabId, this.#now());
      }
    } else {
      if (userInitiated) {
        this.unlock(tabId);
      } else {
        const lastAway = this.#lastUserScrollAwayAtByTab.get(tabId);
        const inCooldown =
          lastAway !== undefined && this.#now() - lastAway < this.#cooldownMs;
        if (!inCooldown) {
          this.unlock(tabId);
        }
      }
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
    const lastAway = this.#lastUserScrollAwayAtByTab.get(tabId);
    if (lastAway !== undefined) {
      if (this.#now() - lastAway < this.#cooldownMs) {
        return false;
      }
      const lastDist = this.#lastDistanceByTab.get(tabId);
      if (lastDist !== undefined && lastDist <= this.#thresholdPx) {
        this.unlock(tabId);
      }
    }
    return this.isFollowing(tabId);
  }
}
