/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest";

// Minimal Obsidian DOM mocks
(HTMLElement.prototype as any).createDiv = function (options: any = {}) {
  const el: any = document.createElement("div");
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
(HTMLElement.prototype as any).createSpan = function (options: any = {}) {
  return (this as any).createEl("span", options);
};
(HTMLElement.prototype as any).createEl = function (tag: string, options: any = {}) {
  const el: any = document.createElement(tag);
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

import {
  DEFAULT_SCROLL_COOLDOWN_MS,
  DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX,
  ScrollFollowController,
  distanceFromBottom,
  isNearBottom,
  readScrollGeometry,
} from "../../src/ui/scroll-lock";

describe("scroll geometry helpers", () => {
  it("computes distance from bottom", () => {
    expect(
      distanceFromBottom({ clientHeight: 200, scrollHeight: 1000, scrollTop: 800 }),
    ).toBe(0);
    expect(
      distanceFromBottom({ clientHeight: 200, scrollHeight: 1000, scrollTop: 700 }),
    ).toBe(100);
  });

  it("treats within-threshold as near bottom", () => {
    const geometry = { clientHeight: 200, scrollHeight: 1000, scrollTop: 768 };
    expect(isNearBottom(geometry, 32)).toBe(true);
    expect(isNearBottom(geometry, 24)).toBe(false);
  });

  it("treats 39px from bottom as near-bottom and 41px as not near-bottom with default 40px threshold", () => {
    expect(DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX).toBe(40);

    // scrollHeight: 1000, clientHeight: 200 -> max scrollTop = 800
    // 39px from bottom: scrollTop = 761 -> dist = 39 <= 40 -> true
    const near39 = { clientHeight: 200, scrollHeight: 1000, scrollTop: 761 };
    expect(distanceFromBottom(near39)).toBe(39);
    expect(isNearBottom(near39)).toBe(true);

    // 41px from bottom: scrollTop = 759 -> dist = 41 > 40 -> false
    const notNear41 = { clientHeight: 200, scrollHeight: 1000, scrollTop: 759 };
    expect(distanceFromBottom(notNear41)).toBe(41);
    expect(isNearBottom(notNear41)).toBe(false);
  });

  it("reads geometry from an element-like object", () => {
    expect(
      readScrollGeometry({ clientHeight: 10, scrollHeight: 50, scrollTop: 5 }),
    ).toEqual({ clientHeight: 10, scrollHeight: 50, scrollTop: 5 });
  });

  it("pins default cooldown to 150ms", () => {
    expect(DEFAULT_SCROLL_COOLDOWN_MS).toBe(150);
  });

  it("exports a default threshold in the recommended band", () => {
    expect(DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX).toBeGreaterThanOrEqual(24);
    expect(DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX).toBeLessThanOrEqual(48);
  });
});

describe("ScrollFollowController", () => {
  it("defaults to following for unknown tabs", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    expect(controller.isFollowing("tab-a")).toBe(true);
    expect(controller.isLocked("tab-a")).toBe(false);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
  });

  it("locks when scrolled away from bottom and freezes auto-scroll", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    controller.syncFromGeometry("tab-a", {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 100,
    });
    expect(controller.isLocked("tab-a")).toBe(true);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
  });

  it("unlocks when user scrolls back near bottom", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    controller.lock("tab-a");
    controller.syncFromGeometry("tab-a", {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 780,
    });
    expect(controller.isFollowing("tab-a")).toBe(true);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
  });

  it("keeps lock state independent per Conversation Tab", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    controller.lock("tab-a");
    expect(controller.isLocked("tab-a")).toBe(true);
    expect(controller.isFollowing("tab-b")).toBe(true);
    expect(controller.shouldAutoScroll("tab-b", "tab-b")).toBe(true);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
  });

  it("does not auto-scroll a hidden source tab (visibility guard)", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    // Both following; still skip when source is not visible.
    expect(controller.shouldAutoScroll("tab-b", "tab-a")).toBe(false);
  });

  it("explicit unlock restores follow after freeze (send new message)", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    controller.lock("tab-a");
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
    controller.unlock("tab-a");
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
  });

  it("forget removes tab lock state", () => {
    const controller = new ScrollFollowController({ thresholdPx: 32 });
    controller.lock("tab-a");
    controller.forget("tab-a");
    expect(controller.isFollowing("tab-a")).toBe(true);
  });

  describe("cooldown behavior (150ms pin cooldown)", () => {
    it("delays automatic follow restoration during cooldown (<150ms), and unlocks after >=150ms", () => {
      let currentTime = 1_000_000;
      const controller = new ScrollFollowController({
        thresholdPx: 40,
        cooldownMs: DEFAULT_SCROLL_COOLDOWN_MS,
        now: () => currentTime,
      });

      // User initially at bottom
      controller.syncFromGeometry("tab-a", {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 800,
      });
      expect(controller.isFollowing("tab-a")).toBe(true);

      // User scrolls away from bottom at t = 1,000,000 (distance = 700px > 40px)
      controller.syncFromGeometry("tab-a", {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 100,
      });
      expect(controller.isLocked("tab-a")).toBe(true);
      expect(controller.isFollowing("tab-a")).toBe(false);
      expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);

      // Immediately (< 150ms, e.g. at t = 1,000,050) geometry returns near bottom via automatic sync
      currentTime = 1_000_050;
      controller.syncFromGeometry("tab-a", {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 800,
      });
      // Assert NOT automatically unlocked
      expect(controller.isLocked("tab-a")).toBe(true);
      expect(controller.isFollowing("tab-a")).toBe(false);
      expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);

      // After cooldown expires (>= 150ms from scroll away, e.g. at t = 1,000,150)
      currentTime = 1_000_150;
      controller.syncFromGeometry("tab-a", {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 800,
      });
      // Assert unlocked
      expect(controller.isFollowing("tab-a")).toBe(true);
      expect(controller.isLocked("tab-a")).toBe(false);
      expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
    });

    it("immediately unlocks on explicit user scroll to bottom even during cooldown (<150ms)", () => {
      let currentTime = 1_000_000;
      const controller = new ScrollFollowController({
        thresholdPx: 40,
        cooldownMs: 150,
        now: () => currentTime,
      });

      // User scrolls away
      controller.syncFromGeometry("tab-a", {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 100,
      });
      expect(controller.isLocked("tab-a")).toBe(true);

      // User explicitly scrolls to bottom 20ms later (< 150ms cooldown)
      currentTime = 1_000_020;
      controller.syncFromGeometry(
        "tab-a",
        { clientHeight: 200, scrollHeight: 1000, scrollTop: 800 },
        { userInitiated: true },
      );

      // Assert immediately unlocked, bypassing cooldown
      expect(controller.isFollowing("tab-a")).toBe(true);
      expect(controller.isLocked("tab-a")).toBe(false);
      expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
    });
  });
});

/**
 * Integration contract for MessageRenderer + ScrollFollowController.
 * These tests fail until MessageRenderer consults the follow controller.
 */
describe("MessageRenderer scroll follow (red→green contract)", () => {
  // Lazy import so pure helper tests above still run if renderer wiring is missing.
  // Implementation lands in message-renderer; this suite pins the product contract.

  it("freezes scrollTop when locked and content grows (streaming append)", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const parent = document.createElement("div");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";
    parent.appendChild(messagesEl);

    const follow = new ScrollFollowController({ thresholdPx: 32 });
    const renderer = new MessageRenderer(messagesEl, { scrollFollow: follow });
    renderer.show("tab-a");

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });
    messagesEl.scrollTop = 100; // far from bottom
    // User scrolled up: drive lock from scroll geometry (no timer polling).
    follow.syncFromGeometry("tab-a", readScrollGeometry(messagesEl));
    expect(follow.isLocked("tab-a")).toBe(true);

    const lockedTop = messagesEl.scrollTop;
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1500, configurable: true });

    // Simulate streaming auto-scroll attempt.
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    renderer.scrollToBottom("tab-a");
    expect(messagesEl.scrollTop).toBe(lockedTop);
  });

  it("follows bottom when unlocked during streaming growth", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const parent = document.createElement("div");
    const messagesEl = document.createElement("div");
    parent.appendChild(messagesEl);

    const follow = new ScrollFollowController({ thresholdPx: 32 });
    const renderer = new MessageRenderer(messagesEl, { scrollFollow: follow });
    renderer.show("tab-a");

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1500, configurable: true });
    messagesEl.scrollTop = 0;
    follow.unlock("tab-a");

    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    renderer.scrollToBottom("tab-a");
    expect(messagesEl.scrollTop).toBe(1500);
  });

  it("force scroll unlocks and jumps to bottom (send new message)", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    const follow = new ScrollFollowController({ thresholdPx: 32 });
    const renderer = new MessageRenderer(messagesEl, { scrollFollow: follow });
    renderer.show("tab-a");
    follow.lock("tab-a");

    Object.defineProperty(messagesEl, "scrollHeight", { value: 900, configurable: true });
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };

    renderer.scrollToBottom("tab-a", { force: true });
    expect(follow.isFollowing("tab-a")).toBe(true);
    expect(messagesEl.scrollTop).toBe(900);
  });

  it("preserves lock when switching away and back to a tab", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    const follow = new ScrollFollowController({ thresholdPx: 32 });
    const renderer = new MessageRenderer(messagesEl, { scrollFollow: follow });
    renderer.show("tab-a");
    follow.lock("tab-a");
    renderer.show("tab-b");
    expect(follow.isLocked("tab-a")).toBe(true);
    renderer.show("tab-a");
    expect(follow.isLocked("tab-a")).toBe(true);
    expect(follow.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
  });

  it("immediately unlocks via MessageRenderer user scroll event within cooldown", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    let currentTime = 1_000_000;
    const follow = new ScrollFollowController({
      thresholdPx: 40,
      cooldownMs: 150,
      now: () => currentTime,
    });
    const renderer = new MessageRenderer(messagesEl, {
      scrollFollow: follow,
      now: () => currentTime,
    });
    renderer.show("tab-a");

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });

    // User scrolls up (scroll away via user input)
    messagesEl.dispatchEvent(new Event("wheel"));
    messagesEl.scrollTop = 100;
    messagesEl.dispatchEvent(new Event("scroll"));
    expect(follow.isLocked("tab-a")).toBe(true);

    // User scrolls to bottom 30ms later (< 150ms cooldown) with explicit input
    currentTime += 30;
    messagesEl.dispatchEvent(new Event("wheel"));
    messagesEl.scrollTop = 800;
    messagesEl.dispatchEvent(new Event("scroll"));

    // Scroll event from user immediately unlocks
    expect(follow.isFollowing("tab-a")).toBe(true);
  });

  it("cooldown suppresses auto-scroll within 150ms and recovers after 150ms via MessageRenderer", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    let currentTime = 1_000_000;
    const follow = new ScrollFollowController({
      thresholdPx: 40,
      cooldownMs: DEFAULT_SCROLL_COOLDOWN_MS,
      now: () => currentTime,
    });
    const renderer = new MessageRenderer(messagesEl, {
      scrollFollow: follow,
      now: () => currentTime,
    });
    renderer.show("tab-a");

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });

    // User scrolls away from bottom
    messagesEl.dispatchEvent(new Event("wheel"));
    messagesEl.scrollTop = 100;
    messagesEl.dispatchEvent(new Event("scroll"));

    expect(follow.isLocked("tab-a")).toBe(true);
    expect(follow.shouldAutoScroll("tab-a", "tab-a")).toBe(false);

    // Streaming scrollToBottom while still scrolled away within cooldown (at t + 50ms)
    currentTime = 1_000_050;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    renderer.scrollToBottom("tab-a");
    // Auto-scroll suppressed
    expect(messagesEl.scrollTop).toBe(100);
    expect(follow.shouldAutoScroll("tab-a", "tab-a")).toBe(false);

    // Inertia/anchoring returns scroll to bottom (without user input event) at t + 110ms
    // (> 100ms user input window, so userInitiated: false, but < 150ms cooldown)
    currentTime = 1_000_110;
    messagesEl.scrollTop = 800;
    messagesEl.dispatchEvent(new Event("scroll"));

    // Cooldown gate in shouldAutoScroll keeps auto-scroll suppressed (< 150ms)
    expect(follow.shouldAutoScroll("tab-a", "tab-a")).toBe(false);

    // Time advances past cooldown (>= 150ms from scroll-away)
    currentTime = 1_000_160;

    // shouldAutoScroll recovers to true
    expect(follow.shouldAutoScroll("tab-a", "tab-a")).toBe(true);

    // Streaming scrollToBottom now executes
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1200, configurable: true });
    renderer.scrollToBottom("tab-a");
    expect(messagesEl.scrollTop).toBe(1200);
  });
});

describe("MessageRenderer scroll fade masks", () => {
  it("toggles has-more-above and has-more-below based on geometry (scrollTop and distanceFromBottom)", async () => {
    const { MessageRenderer, SCROLL_FADE_THRESHOLD_PX } = await import("../../src/ui/message-renderer");
    expect(SCROLL_FADE_THRESHOLD_PX).toBe(8);

    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });

    const renderer = new MessageRenderer(messagesEl);
    renderer.show("tab-a");

    // Case 1: scrollTop = 0 -> no has-more-above, has-more-below is present
    messagesEl.scrollTop = 0;
    renderer.updateScrollFadeMasks({ immediate: true });
    expect(messagesEl.classList.contains("has-more-above")).toBe(false);
    expect(messagesEl.classList.contains("has-more-below")).toBe(true);

    // Case 2: scrollTop = 100 -> has-more-above is present, has-more-below is present
    messagesEl.scrollTop = 100;
    renderer.updateScrollFadeMasks({ immediate: true });
    expect(messagesEl.classList.contains("has-more-above")).toBe(true);
    expect(messagesEl.classList.contains("has-more-below")).toBe(true);

    // Case 3: At bottom (scrollTop = 800, dist = 0) -> has-more-above is present, no has-more-below
    messagesEl.scrollTop = 800;
    renderer.updateScrollFadeMasks({ immediate: true });
    expect(messagesEl.classList.contains("has-more-above")).toBe(true);
    expect(messagesEl.classList.contains("has-more-below")).toBe(false);

    // Case 4: When content does not overflow (scrollHeight = 200, clientHeight = 200) -> neither class present
    Object.defineProperty(messagesEl, "scrollHeight", { value: 200, configurable: true });
    messagesEl.scrollTop = 0;
    renderer.updateScrollFadeMasks({ immediate: true });
    expect(messagesEl.classList.contains("has-more-above")).toBe(false);
    expect(messagesEl.classList.contains("has-more-below")).toBe(false);
  });

  it("updates fade masks during user scroll events", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });

    const renderer = new MessageRenderer(messagesEl);
    renderer.show("tab-a");

    messagesEl.scrollTop = 100;
    messagesEl.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 20));

    expect(messagesEl.classList.contains("has-more-above")).toBe(true);
    expect(messagesEl.classList.contains("has-more-below")).toBe(true);
  });

  it("updates fade masks during TurnManager streaming append", async () => {
    const { MessageRenderer, TurnManager } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 200, configurable: true });

    const renderer = new MessageRenderer(messagesEl);
    renderer.show("tab-a");

    const turnManager = new TurnManager(renderer);

    // Initially no overflow
    expect(messagesEl.classList.contains("has-more-below")).toBe(false);

    // Streaming append arrives and content expands
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });
    turnManager.appendDelta("tab-a", "Hello world delta");
    await new Promise((r) => setTimeout(r, 20));

    // Fade mask updated: now has more below!
    expect(messagesEl.classList.contains("has-more-below")).toBe(true);
  });

  it("coalesces multiple updateScrollFadeMasks calls in the same frame", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    let rafCount = 0;
    const originalRaf = window.requestAnimationFrame;
    // Async rAF (does not execute callback synchronously during loop)
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCount += 1;
      return setTimeout(() => cb(0), 16) as any;
    };

    try {
      const renderer = new MessageRenderer(messagesEl);
      // Let initial constructor rAF settle
      await new Promise((r) => setTimeout(r, 25));
      rafCount = 0;

      // Fire 10 updates in rapid succession
      for (let i = 0; i < 10; i++) {
        renderer.updateScrollFadeMasks();
      }

      // Exactly 1 rAF frame scheduled
      expect(rafCount).toBe(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });

  it("cancels pending rAF on destroy and forget", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    let cancelledId: number | null = null;
    const originalCancel = window.cancelAnimationFrame;
    window.cancelAnimationFrame = (id: number) => {
      cancelledId = id;
      originalCancel(id);
    };

    try {
      const renderer = new MessageRenderer(messagesEl);
      renderer.show("tab-a");

      renderer.updateScrollFadeMasks();
      expect(cancelledId).toBeNull();

      // destroy cancels pending rAF
      renderer.destroy();
      expect(cancelledId).not.toBeNull();

      // forget of visible tab also cancels
      cancelledId = null;
      renderer.updateScrollFadeMasks();
      renderer.forget("tab-a");
      expect(cancelledId).not.toBeNull();
    } finally {
      window.cancelAnimationFrame = originalCancel;
    }
  });

  it("caches boolean states and does not write to DOM when geometry has not changed", async () => {
    const { MessageRenderer } = await import("../../src/ui/message-renderer");
    const messagesEl = document.createElement("div");
    messagesEl.className = "hermesian-messages";

    Object.defineProperty(messagesEl, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messagesEl, "scrollHeight", { value: 1000, configurable: true });
    messagesEl.scrollTop = 0;

    const renderer = new MessageRenderer(messagesEl);
    renderer.updateScrollFadeMasks({ immediate: true });

    let toggleCalls = 0;
    const originalToggle = messagesEl.classList.toggle.bind(messagesEl.classList);
    messagesEl.classList.toggle = (token: string, force?: boolean) => {
      toggleCalls += 1;
      return originalToggle(token, force);
    };

    try {
      // Re-run with unchanged geometry
      renderer.updateScrollFadeMasks({ immediate: true });
      // Cached values matched, zero toggle writes
      expect(toggleCalls).toBe(0);

      // Now change geometry to cross threshold
      messagesEl.scrollTop = 100;
      renderer.updateScrollFadeMasks({ immediate: true });
      // Only has-more-above flipped from false to true -> exactly 1 write
      expect(toggleCalls).toBe(1);
    } finally {
      messagesEl.classList.toggle = originalToggle;
    }
  });
});
