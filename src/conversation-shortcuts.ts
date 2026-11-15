export type ConversationShortcut = "add" | "close";

/**
 * Match only the physical W/N key with Option (Alt), without other modifiers.
 * event.key is deliberately ignored: macOS Option turns it into a character
 * such as a tilde, whose value also depends on the active keyboard layout.
 */
export function conversationShortcutForEvent(
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "metaKey"
    | "ctrlKey"
    | "shiftKey"
    | "code"
    | "repeat"
    | "isComposing"
    | "defaultPrevented"
  > & { keyCode?: number },
): ConversationShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
    return null;
  }
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.repeat) {
    return null;
  }
  if (event.code === "KeyN") {
    return "add";
  }
  if (event.code === "KeyW") {
    return "close";
  }
  return null;
}
