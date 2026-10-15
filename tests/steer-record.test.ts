/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from "vitest";

import { MessageRenderer, TurnManager, shouldRecordSteer } from "../src/ui/message-renderer";
import type { SteerResult } from "../src/types";

// Minimal DOM mocks matching Obsidian's HTMLElement helpers
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

function setupEnvironment() {
  const parent = document.createElement("div");
  const messagesEl = parent.createDiv({ cls: "hermesian-messages" });
  const renderer = new MessageRenderer(messagesEl as HTMLElement);
  renderer.show("tab-1");
  const turnCallbacks = { onTurnComplete: vi.fn() };
  const turns = new TurnManager(renderer, turnCallbacks);
  return { parent, messagesEl, renderer, turns, turnCallbacks };
}

describe("shouldRecordSteer", () => {
  it("records successful steer without queued marker", () => {
    const result: SteerResult = { ok: true };
    expect(shouldRecordSteer(result)).toEqual({ record: true, queued: false });
  });

  it("records queued steer with queued marker", () => {
    const result: SteerResult = { ok: false, reason: "queued" };
    expect(shouldRecordSteer(result)).toEqual({ record: true, queued: true });
  });

  it("does not record on steer_failed", () => {
    const result: SteerResult = { ok: false, reason: "steer_failed" };
    expect(shouldRecordSteer(result)).toEqual({ record: false });
  });

  it("does not record on unverifiable", () => {
    const result: SteerResult = { ok: false, reason: "unverifiable" };
    expect(shouldRecordSteer(result)).toEqual({ record: false });
  });

  it("does not record on no_active_turn", () => {
    const result: SteerResult = { ok: false, reason: "no_active_turn" };
    expect(shouldRecordSteer(result)).toEqual({ record: false });
  });

  it("does not record on steer_in_flight", () => {
    const result: SteerResult = { ok: false, reason: "steer_in_flight" };
    expect(shouldRecordSteer(result)).toEqual({ record: false });
  });
});

describe("Steer Record visualization", () => {
  // Requirement 1: On steer success (result.ok === true): insert a Steer Record into the conversation flow
  it("(a) successful steer inserts record with text", () => {
    const { turns, messagesEl } = setupEnvironment();
    turns.ensureActivity("tab-1");
    const disposition = shouldRecordSteer({ ok: true });
    expect(disposition.record).toBe(true);
    if (!disposition.record) return;

    const record = turns.appendSteer("tab-1", "Make the function async", disposition.queued);
    expect(record).toBeDefined();

    expect(record!.tagName).toBe("DETAILS");
    expect(record!.classList.contains("hermesian-steer-record")).toBe(true);
    expect(record!.classList.contains("is-queued")).toBe(false);

    // Summary contains Steer label with dedicated class and no queued marker
    const summary = record!.querySelector("summary");
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toBe("Steer");
    const labelSpan = summary!.querySelector(".hermesian-steer-record-label");
    expect(labelSpan).not.toBeNull();
    expect(labelSpan!.textContent).toBe("Steer");
    expect(record!.querySelector(".hermesian-steer-marker")).toBeNull();

    // Body contains the steered text in pre
    const pre = record!.querySelector("pre.hermesian-steer-content");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("Make the function async");

    // Element is inside turn activity container when no assistant bubble exists yet
    const activity = messagesEl.querySelector(".hermesian-turn-activity");
    expect(activity).not.toBeNull();
    expect(activity!.contains(record!)).toBe(true);
  });

  // Requirement 2: On queued: insert the same Steer Record but with a visible "queued" marker
  it("(b) queued steer inserts record with queued marker", () => {
    const { turns, messagesEl } = setupEnvironment();
    turns.ensureActivity("tab-1");
    const disposition = shouldRecordSteer({ ok: false, reason: "queued" });
    expect(disposition.record).toBe(true);
    if (!disposition.record) return;

    const record = turns.appendSteer("tab-1", "Queued correction text", disposition.queued);
    expect(record).toBeDefined();

    expect(record!.tagName).toBe("DETAILS");
    expect(record!.classList.contains("hermesian-steer-record")).toBe(true);
    expect(record!.classList.contains("is-queued")).toBe(true);

    const summary = record!.querySelector("summary");
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain("Steer");
    expect(summary!.textContent).toContain("queued for next turn");
    const labelSpan = summary!.querySelector(".hermesian-steer-record-label");
    expect(labelSpan).not.toBeNull();
    expect(labelSpan!.textContent).toBe("Steer");

    const marker = record!.querySelector(".hermesian-steer-marker");
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toContain("queued for next turn");

    const pre = record!.querySelector("pre.hermesian-steer-content");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("Queued correction text");

    const activity = messagesEl.querySelector(".hermesian-turn-activity");
    expect(activity!.contains(record!)).toBe(true);
  });

  // Requirement 3: On other failures: no record (steer_failed / unverifiable insert nothing)
  it("(c) steer_failed and unverifiable insert nothing", () => {
    const { turns, messagesEl } = setupEnvironment();

    const failedDisp = shouldRecordSteer({ ok: false, reason: "steer_failed" });
    expect(failedDisp.record).toBe(false);
    if (failedDisp.record) {
      turns.appendSteer("tab-1", "should not be called", failedDisp.queued);
    }

    const unverifiableDisp = shouldRecordSteer({ ok: false, reason: "unverifiable" });
    expect(unverifiableDisp.record).toBe(false);
    if (unverifiableDisp.record) {
      turns.appendSteer("tab-1", "should not be called", unverifiableDisp.queued);
    }

    expect(messagesEl.querySelector(".hermesian-steer-record")).toBeNull();
  });

  // Requirement 4: Queued marker lifecycle: when the NEXT turn begins, clear the queued marker
  it("(d) starting the next turn clears queued markers", () => {
    const { turns, renderer } = setupEnvironment();

    // Turn 1: user steers and it gets queued
    turns.ensureActivity("tab-1");
    const record = turns.appendSteer("tab-1", "Steer while busy", true);
    expect(record).toBeDefined();
    expect(record!.classList.contains("is-queued")).toBe(true);
    expect(record!.querySelector(".hermesian-steer-marker")).not.toBeNull();
    expect(record!.querySelector("summary")!.textContent).toContain("queued for next turn");

    // Turn 1 settles
    const rt = turns.ensure("tab-1");
    rt.activeTurnEl = undefined;
    rt.turnActivityEl = undefined;

    // NEXT turn begins: line ~2330 view.ts clears queued markers, resets streaming, and creates new activeTurnEl
    turns.clearQueuedSteers("tab-1");
    rt.activeTurnEl = renderer.containerFor("tab-1").createDiv({ cls: "hermesian-turn" });

    // The record from Turn 1 now has queued marker cleared
    expect(record!.classList.contains("is-queued")).toBe(false);
    expect(record!.querySelector(".hermesian-steer-marker")).toBeNull();
    expect(record!.querySelector("summary")!.textContent).toBe("Steer");
    // Text remains intact
    expect(record!.querySelector("pre.hermesian-steer-content")!.textContent).toBe("Steer while busy");
  });

  it("clears queued markers when server-driven next turn begins via ensureActivity / appendDelta (G1)", () => {
    const { turns } = setupEnvironment();

    // Turn 1: user steers and it gets queued
    turns.ensureActivity("tab-1");
    const record = turns.appendSteer("tab-1", "Steer while turn 1 busy", true);
    expect(record).toBeDefined();
    expect(record!.classList.contains("is-queued")).toBe(true);

    // Turn 1 settles: activeTurnEl is cleared
    const rt = turns.ensure("tab-1");
    rt.activeTurnEl = undefined;
    rt.turnActivityEl = undefined;

    // Server-driven turn 2 begins autonomously via delta arrival without entering sendMessage
    turns.appendDelta("tab-1", "Autonomous next turn streaming delta");

    // The queued marker from Turn 1 must now be cleared by ensureActivity creating the new turn scaffold
    expect(record!.classList.contains("is-queued")).toBe(false);
    expect(record!.querySelector(".hermesian-steer-marker")).toBeNull();
    expect(record!.querySelector("summary")!.textContent).toBe("Steer");
  });

  it("clears multiple pending queued steer records on next turn", () => {
    const { turns } = setupEnvironment();
    turns.ensureActivity("tab-1");

    const record1 = turns.appendSteer("tab-1", "first steer", true);
    const record2 = turns.appendSteer("tab-1", "second steer", true);
    expect(record1).toBeDefined();
    expect(record2).toBeDefined();

    expect(record1!.classList.contains("is-queued")).toBe(true);
    expect(record2!.classList.contains("is-queued")).toBe(true);

    turns.clearQueuedSteers("tab-1");

    expect(record1!.classList.contains("is-queued")).toBe(false);
    expect(record2!.classList.contains("is-queued")).toBe(false);
    expect(record1!.querySelector(".hermesian-steer-marker")).toBeNull();
    expect(record2!.querySelector(".hermesian-steer-marker")).toBeNull();
    expect(record1!.querySelector("summary")!.textContent).toBe("Steer");
    expect(record2!.querySelector("summary")!.textContent).toBe("Steer");
  });

  it("isolates queued records across tabs", () => {
    const { turns, renderer } = setupEnvironment();
    renderer.show("tab-2");
    turns.ensureActivity("tab-1");
    turns.ensureActivity("tab-2");

    const recordTab1 = turns.appendSteer("tab-1", "steer tab 1", true);
    const recordTab2 = turns.appendSteer("tab-2", "steer tab 2", true);
    expect(recordTab1).toBeDefined();
    expect(recordTab2).toBeDefined();

    // Only clear tab 1
    turns.clearQueuedSteers("tab-1");

    expect(recordTab1!.classList.contains("is-queued")).toBe(false);
    expect(recordTab1!.querySelector(".hermesian-steer-marker")).toBeNull();

    // Tab 2 remains queued
    expect(recordTab2!.classList.contains("is-queued")).toBe(true);
    expect(recordTab2!.querySelector(".hermesian-steer-marker")).not.toBeNull();
  });

  // F1: Orphan turn scaffold guard
  it("does not resurrect scaffold when turn is no longer live (activeTurnEl is undefined)", () => {
    const { turns, messagesEl } = setupEnvironment();
    // No active turn started
    const record = turns.appendSteer("tab-1", "steer after turn completed", false);
    expect(record).toBeUndefined();
    expect(messagesEl.querySelector(".hermesian-turn")).toBeNull();
    expect(messagesEl.querySelector(".hermesian-steer-record")).toBeNull();
  });

  // F2: DOM order: streamed text bubble → steer record → post-steer bubble
  it("renders steer record after already-streamed assistant text and before post-steer bubble", () => {
    const { turns, messagesEl } = setupEnvironment();
    // 1. Assistant text streams before steer
    turns.appendDelta("tab-1", "First streamed bubble text");
    const turnEl = messagesEl.querySelector(".hermesian-turn")!;
    expect(turnEl).not.toBeNull();

    const firstBubble = turnEl.querySelector(".hermesian-message.is-assistant");
    expect(firstBubble).not.toBeNull();
    expect(firstBubble!.textContent).toBe("First streamed bubble text");

    // 2. Steer arrives while assistant content exists
    const record = turns.appendSteer("tab-1", "Steer instruction");
    expect(record).toBeDefined();

    // Steer record was appended directly to activeTurnEl, NOT inside turnActivityEl
    expect(record!.parentElement).toBe(turnEl);
    const activityEl = turnEl.querySelector(".hermesian-turn-activity")!;
    expect(activityEl.contains(record!)).toBe(false);

    // 3. Post-steer assistant text arrives
    turns.appendDelta("tab-1", "Second streamed bubble text");

    const assistantBubbles = turnEl.querySelectorAll(".hermesian-message.is-assistant");
    expect(assistantBubbles.length).toBe(2);
    const secondBubble = assistantBubbles[1];

    // Assert strict DOM child order:
    // [0]: hermesian-turn-activity
    // [1]: first streamed text bubble
    // [2]: steer record
    // [3]: post-steer bubble
    const children = Array.from(turnEl.children);
    const firstIdx = children.indexOf(firstBubble!);
    const recordIdx = children.indexOf(record!);
    const secondIdx = children.indexOf(secondBubble);

    expect(firstIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeGreaterThan(recordIdx);
  });

  it("does not duplicate text across pre-steer and post-steer assistant bubbles", () => {
    const { turns, messagesEl } = setupEnvironment();
    turns.appendDelta("tab-1", "before");

    const record = turns.appendSteer("tab-1", "steer instruction");
    expect(record).toBeDefined();

    turns.appendDelta("tab-1", "after");

    const turnEl = messagesEl.querySelector(".hermesian-turn")!;
    expect(turnEl).not.toBeNull();

    const assistantBubbles = turnEl.querySelectorAll(".hermesian-message.is-assistant");
    expect(assistantBubbles.length).toBe(2);

    const firstBubble = assistantBubbles[0];
    const secondBubble = assistantBubbles[1];

    // Assert three separate artifacts in order
    const children = Array.from(turnEl.children);
    const firstIdx = children.indexOf(firstBubble);
    const recordIdx = children.indexOf(record!);
    const secondIdx = children.indexOf(secondBubble);

    expect(firstIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeGreaterThan(recordIdx);

    // Bubble containing "before" and NOT "after"
    expect(firstBubble.textContent).toContain("before");
    expect(firstBubble.textContent).not.toContain("after");

    // Bubble containing "after" and NOT "before" (no text duplication)
    expect(secondBubble.textContent).toContain("after");
    expect(secondBubble.textContent).not.toContain("before");
  });

  it("renders consecutive steers in correct chronological order after assistant bubble (G2)", () => {
    const { turns, messagesEl } = setupEnvironment();

    // 1. Assistant text streams first
    turns.appendDelta("tab-1", "Initial assistant bubble");
    const turnEl = messagesEl.querySelector(".hermesian-turn")!;
    const assistantBubble = turnEl.querySelector(".hermesian-message.is-assistant")!;
    expect(assistantBubble).not.toBeNull();

    // 2. First steer arrives (clears assistantContentEl)
    const steer1 = turns.appendSteer("tab-1", "First steer instruction");
    expect(steer1).toBeDefined();

    // 3. Second consecutive steer arrives without intervening delta
    const steer2 = turns.appendSteer("tab-1", "Second consecutive steer instruction");
    expect(steer2).toBeDefined();

    // Both steers must be children of activeTurnEl, NOT inside turnActivityEl
    expect(steer1!.parentElement).toBe(turnEl);
    expect(steer2!.parentElement).toBe(turnEl);
    const activityEl = turnEl.querySelector(".hermesian-turn-activity")!;
    expect(activityEl.contains(steer1!)).toBe(false);
    expect(activityEl.contains(steer2!)).toBe(false);

    // Assert chronological order: activity -> assistant bubble -> steer1 -> steer2
    const children = Array.from(turnEl.children);
    const activityIdx = children.indexOf(activityEl);
    const assistantIdx = children.indexOf(assistantBubble);
    const steer1Idx = children.indexOf(steer1!);
    const steer2Idx = children.indexOf(steer2!);

    expect(activityIdx).toBeLessThan(assistantIdx);
    expect(assistantIdx).toBeLessThan(steer1Idx);
    expect(steer1Idx).toBeLessThan(steer2Idx);

    // 4. Subsequent delta streams into a new assistant bubble after steer2
    turns.appendDelta("tab-1", "Post-consecutive-steers bubble");
    const bubbles = turnEl.querySelectorAll(".hermesian-message.is-assistant");
    expect(bubbles.length).toBe(2);
    const secondBubbleIdx = Array.from(turnEl.children).indexOf(bubbles[1]);
    expect(secondBubbleIdx).toBeGreaterThan(steer2Idx);
  });

  it("renders consecutive steers in correct chronological order when no assistant bubble exists (G2)", () => {
    const { turns, messagesEl } = setupEnvironment();
    turns.ensureActivity("tab-1");
    turns.appendThought("tab-1", "Thinking...");

    const steerA = turns.appendSteer("tab-1", "Steer A");
    const steerB = turns.appendSteer("tab-1", "Steer B");
    expect(steerA).toBeDefined();
    expect(steerB).toBeDefined();

    const activityEl = messagesEl.querySelector(".hermesian-turn-activity")!;
    expect(activityEl.contains(steerA!)).toBe(true);
    expect(activityEl.contains(steerB!)).toBe(true);

    const activityChildren = Array.from(activityEl.children);
    const steerAIdx = activityChildren.indexOf(steerA!);
    const steerBIdx = activityChildren.indexOf(steerB!);
    expect(steerAIdx).toBeLessThan(steerBIdx);
  });

  it("maintains streaming state invariants for finalizeAssistantMessage semantics", () => {
    const { turns } = setupEnvironment();
    turns.appendDelta("tab-1", "pre-steer text");

    const rt = turns.ensure("tab-1");
    expect(rt.assistantContentEl).toBeDefined();
    expect(rt.assistantText).toBe("pre-steer text");

    // Steer arrives with prior bubble
    turns.appendSteer("tab-1", "steer instruction");

    // Invariant that view.ts finalizeAssistantMessage relies on:
    // assistantContentEl is undefined and assistantText is empty,
    // so finalize's early return (!target || !text) is coherent when turn ends with no further delta.
    expect(rt.assistantContentEl).toBeUndefined();
    expect(rt.assistantText).toBe("");

    // Simulate finalize early return path
    const targetPre = rt.assistantContentEl;
    const textPre = rt.assistantText;
    expect(!targetPre || !textPre).toBe(true);

    // When deltas arrive post-steer, assistantText equals ONLY post-steer text
    turns.appendDelta("tab-1", "post-steer text");
    expect(rt.assistantContentEl).toBeDefined();
    expect(rt.assistantText).toBe("post-steer text");

    // Simulate finalizeAssistantMessage post-steer
    const targetPost = rt.assistantContentEl;
    const textPost = rt.assistantText;
    rt.assistantContentEl = undefined;
    rt.assistantText = "";
    expect(targetPost).toBeDefined();
    expect(textPost).toBe("post-steer text");
  });

  it("leaves streaming state untouched when steer has no prior bubble", () => {
    const { turns, messagesEl } = setupEnvironment();
    turns.ensureActivity("tab-1");
    turns.appendThought("tab-1", "pondering...");

    const rt = turns.ensure("tab-1");
    expect(rt.assistantContentEl).toBeUndefined();
    expect(rt.assistantText).toBe("");
    const thoughtContentEl = rt.thoughtContentEl;
    expect(thoughtContentEl).toBeDefined();

    const record = turns.appendSteer("tab-1", "steer without prior assistant bubble");
    expect(record).toBeDefined();

    // Record lands in activity container
    const activityEl = messagesEl.querySelector(".hermesian-turn-activity")!;
    expect(activityEl).not.toBeNull();
    expect(activityEl.contains(record!)).toBe(true);

    // Streaming state is untouched
    expect(rt.assistantContentEl).toBeUndefined();
    expect(rt.assistantText).toBe("");
    expect(rt.thoughtContentEl).toBe(thoughtContentEl);
  });
});
