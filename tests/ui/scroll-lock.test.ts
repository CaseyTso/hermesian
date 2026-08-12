/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest";

import {
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

  it("reads geometry from an element-like object", () => {
    expect(
      readScrollGeometry({ clientHeight: 10, scrollHeight: 50, scrollTop: 5 }),
    ).toEqual({ clientHeight: 10, scrollHeight: 50, scrollTop: 5 });
  });

  it("exports a default threshold in the recommended band", () => {
    expect(DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX).toBeGreaterThanOrEqual(24);
    expect(DEFAULT_SCROLL_FOLLOW_THRESHOLD_PX).toBeLessThanOrEqual(48);
  });
});

describe("ScrollFollowController", () => {
  it("defaults to following for unknown tabs", () => {
    const controller = new ScrollFollowController(32);
    expect(controller.isFollowing("tab-a")).toBe(true);
    expect(controller.isLocked("tab-a")).toBe(false);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
  });

  it("locks when scrolled away from bottom and freezes auto-scroll", () => {
    const controller = new ScrollFollowController(32);
    controller.syncFromGeometry("tab-a", {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 100,
    });
    expect(controller.isLocked("tab-a")).toBe(true);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
  });

  it("unlocks when user scrolls back near bottom", () => {
    const controller = new ScrollFollowController(32);
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
    const controller = new ScrollFollowController(32);
    controller.lock("tab-a");
    expect(controller.isLocked("tab-a")).toBe(true);
    expect(controller.isFollowing("tab-b")).toBe(true);
    expect(controller.shouldAutoScroll("tab-b", "tab-b")).toBe(true);
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
  });

  it("does not auto-scroll a hidden source tab (visibility guard)", () => {
    const controller = new ScrollFollowController(32);
    // Both following; still skip when source is not visible.
    expect(controller.shouldAutoScroll("tab-b", "tab-a")).toBe(false);
  });

  it("explicit unlock restores follow after freeze (send new message)", () => {
    const controller = new ScrollFollowController(32);
    controller.lock("tab-a");
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
    controller.unlock("tab-a");
    expect(controller.shouldAutoScroll("tab-a", "tab-a")).toBe(true);
  });

  it("forget removes tab lock state", () => {
    const controller = new ScrollFollowController(32);
    controller.lock("tab-a");
    controller.forget("tab-a");
    expect(controller.isFollowing("tab-a")).toBe(true);
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

    const follow = new ScrollFollowController(32);
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

    const follow = new ScrollFollowController(32);
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
    const follow = new ScrollFollowController(32);
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
    const follow = new ScrollFollowController(32);
    const renderer = new MessageRenderer(messagesEl, { scrollFollow: follow });
    renderer.show("tab-a");
    follow.lock("tab-a");
    renderer.show("tab-b");
    expect(follow.isLocked("tab-a")).toBe(true);
    renderer.show("tab-a");
    expect(follow.isLocked("tab-a")).toBe(true);
    expect(follow.shouldAutoScroll("tab-a", "tab-a")).toBe(false);
  });
});
