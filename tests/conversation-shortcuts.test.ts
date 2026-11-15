import { describe, expect, it } from "vitest";

import { conversationShortcutForEvent } from "../src/conversation-shortcuts";

function shortcutEvent(overrides: Record<string, unknown> = {}) {
  return {
    altKey: true,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    code: "KeyN",
    ...overrides,
  };
}

describe("conversationShortcutForEvent", () => {
  it.each([
    ["KeyN", "˜", "add"],
    ["KeyW", "∑", "close"],
  ] as const)(
    "uses physical %s even when macOS Option changes key to %s",
    (code, key, expected) => {
      expect(conversationShortcutForEvent(shortcutEvent({ code, key }))).toBe(expected);
    },
  );

  it("ignores additional modifiers, repeats, composition, and handled events", () => {
    for (const overrides of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: false },
      { repeat: true },
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true },
      { code: "KeyA" },
    ]) {
      expect(conversationShortcutForEvent(shortcutEvent(overrides))).toBeNull();
    }
  });
});
