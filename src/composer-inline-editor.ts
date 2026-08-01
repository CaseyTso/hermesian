import {
  applyInlineDraftEdit,
  insertInlineReference,
  recognizeReferenceToken,
  referenceTokenDisplayLabel,
  type ComposerInlineDraft,
  type InlineReference,
  type ReferenceTokenKind,
} from "./composer-reference-tokens";

/**
 * Contenteditable adapter layer for the composer.
 *
 * The editor DOM is a projection of the canonical ComposerInlineDraft:
 * plain text lives in text nodes (newlines as <br>), and every reference is
 * an atomic `contenteditable=false` capsule span carrying its FULL value in
 * `data-ref-value` (also in title/aria-label). Ordinary typing is synced by
 * READING the DOM back into the model (never a full re-render, so the
 * browser caret is never disturbed); structural edits (paste, capsule
 * removal, restore) re-render with an explicit caret offset.
 */

export const INLINE_REF_CAPSULE_CLASS = "hermesian-inline-ref";
const CAPSULE_DATA = "data-ref-value";
const CAPSULE_KIND = "data-ref-kind";

export interface InlineEditorRenderOptions {
  /** Called when a capsule's remove button is clicked. */
  onRemoveReference?(index: number): void;
  /** Optional icon renderer (host injects Obsidian's setIcon). */
  renderIcon?(iconEl: HTMLElement, kind: ReferenceTokenKind): void;
}

/** Normalize clipboard/IME newlines to \n (single canonical form). */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** UTF-16 length of a node's contribution to the editable text. */
function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length;
  }
  if (node instanceof HTMLElement) {
    if (node.classList.contains(INLINE_REF_CAPSULE_CLASS)) {
      return (node.getAttribute(CAPSULE_DATA) ?? "").length;
    }
    if (node.tagName === "BR") {
      return 1;
    }
    let length = 0;
    for (const child of Array.from(node.childNodes)) {
      length += nodeLength(child);
    }
    return length;
  }
  return 0;
}

/**
 * Map a DOM position (node + offset) to a UTF-16 offset in the editable
 * text. Offsets inside a capsule resolve to the capsule start (atomic).
 */
export function domOffsetToUtf16(
  editorEl: HTMLElement,
  node: Node,
  offset: number,
): number {
  const chain: Node[] = [];
  let current: Node | null = node;
  while (current !== null && current !== editorEl) {
    chain.unshift(current);
    current = current.parentNode;
  }
  if (current !== editorEl) {
    return 0;
  }
  let cursor = 0;
  let parent: Node = editorEl;
  for (const child of chain) {
    for (const sibling of Array.from(parent.childNodes)) {
      if (sibling === child) {
        break;
      }
      cursor += nodeLength(sibling);
    }
    parent = child;
  }
  cursor += offsetInNode(node, offset);
  return cursor;
}

function offsetInNode(node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.min(offset, (node as Text).data.length);
  }
  if (node instanceof HTMLElement) {
    if (node.classList.contains(INLINE_REF_CAPSULE_CLASS)) {
      return 0;
    }
    if (node.tagName === "BR") {
      return 0;
    }
    let cursor = 0;
    const children = Array.from(node.childNodes);
    for (let index = 0; index < Math.min(offset, children.length); index += 1) {
      cursor += nodeLength(children[index]!);
    }
    return cursor;
  }
  return 0;
}

/**
 * Resolve a UTF-16 offset to a DOM position. A caret that would land inside
 * a capsule snaps to the capsule boundary (before it); a caret exactly at a
 * capsule end resolves after it.
 */
export function utf16OffsetToDom(
  editorEl: HTMLElement,
  offset: number,
): { node: Node; offset: number } {
  const result = { node: editorEl as Node, offset: 0 };
  if (editorEl.childNodes.length === 0) {
    return result;
  }
  let remaining = offset;
  const walk = (parent: Node): boolean => {
    for (const child of Array.from(parent.childNodes)) {
      const length = nodeLength(child);
      if (remaining < length) {
        if (child.nodeType === Node.TEXT_NODE) {
          result.node = child;
          result.offset = remaining;
          return true;
        }
        if (child instanceof HTMLElement) {
          if (
            child.classList.contains(INLINE_REF_CAPSULE_CLASS) ||
            child.tagName === "BR"
          ) {
            result.node = parent;
            result.offset = Array.from(parent.childNodes).indexOf(child);
            return true;
          }
          if (walk(child)) {
            return true;
          }
        }
        result.node = parent;
        result.offset = Array.from(parent.childNodes).indexOf(child);
        return true;
      }
      remaining -= length;
    }
    result.node = parent;
    result.offset = parent.childNodes.length;
    return true;
  };
  walk(editorEl);
  return result;
}

/** Read the canonical draft back from the DOM (independent of the model). */
export function readInlineDraftFromDom(
  editorEl: HTMLElement,
): Pick<ComposerInlineDraft, "text" | "references"> {
  let text = "";
  const references: InlineReference[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.classList.contains(INLINE_REF_CAPSULE_CLASS)) {
        const value = node.getAttribute(CAPSULE_DATA) ?? "";
        const kind = node.getAttribute(CAPSULE_KIND);
        if ((kind === "url" || kind === "path") && value.length > 0) {
          references.push({ kind, value, start: text.length });
          text += value;
        } else {
          text += node.textContent ?? "";
        }
        return;
      }
      if (node.tagName === "BR") {
        text += "\n";
        return;
      }
      const block = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE)$/.test(node.tagName);
      if (block) {
        text += "\n";
      }
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
      if (block) {
        text += "\n";
      }
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
  };
  for (const child of Array.from(editorEl.childNodes)) {
    walk(child);
  }
  return { text, references };
}

/**
 * Re-render the editor from the model, preserving (or honoring an explicit)
 * caret offset. Only used for structural changes — ordinary typing goes
 * through handleInlineEditorInput without touching the DOM.
 */
export function renderInlineDraft(
  editorEl: HTMLElement,
  draft: ComposerInlineDraft,
  options: InlineEditorRenderOptions = {},
  caretOffset?: number,
): void {
  const requestedCaret = caretOffset ?? getCaretOffset(editorEl) ?? 0;
  while (editorEl.firstChild) {
    editorEl.removeChild(editorEl.firstChild);
  }
  const doc = editorEl.ownerDocument;
  const appendTextSegment = (segment: string): void => {
    const parts = segment.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        editorEl.appendChild(doc.createElement("br"));
      }
      if (part.length > 0) {
        editorEl.appendChild(doc.createTextNode(part));
      }
    });
  };
  const appendCapsule = (reference: InlineReference, index: number): void => {
    const capsule = doc.createElement("span");
    capsule.className = `${INLINE_REF_CAPSULE_CLASS} is-${reference.kind}`;
    capsule.setAttribute("contenteditable", "false");
    capsule.setAttribute("title", reference.value);
    capsule.setAttribute(
      "aria-label",
      `Reference ${reference.kind === "url" ? "URL" : "path"} ${reference.value}`,
    );
    capsule.setAttribute(CAPSULE_DATA, reference.value);
    capsule.setAttribute(CAPSULE_KIND, reference.kind);
    if (options.renderIcon) {
      const icon = doc.createElement("span");
      icon.className = "hermesian-inline-ref-icon";
      options.renderIcon(icon, reference.kind);
      capsule.appendChild(icon);
    }
    const label = doc.createElement("span");
    label.className = "hermesian-inline-ref-label";
    label.textContent = referenceTokenDisplayLabel(reference);
    capsule.appendChild(label);
    if (options.onRemoveReference) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "hermesian-inline-ref-remove";
      button.setAttribute(
        "aria-label",
        `Remove reference ${reference.kind === "url" ? "URL" : "path"} ${reference.value}`,
      );
      button.addEventListener("click", () => {
        options.onRemoveReference?.(index);
      });
      capsule.appendChild(button);
    }
    editorEl.appendChild(capsule);
  };

  let cursor = 0;
  for (const reference of draft.references) {
    if (reference.start > cursor) {
      appendTextSegment(draft.text.slice(cursor, reference.start));
    }
    appendCapsule(reference, draft.references.indexOf(reference));
    cursor = reference.start + reference.value.length;
  }
  if (cursor < draft.text.length) {
    appendTextSegment(draft.text.slice(cursor));
  }
  setCaretOffset(editorEl, Math.min(requestedCaret, draft.text.length));
}

/** Selection helpers (UTF-16 offsets in the canonical text). */
export function setSelectionOffsets(
  editorEl: HTMLElement,
  start: number,
  end: number,
): void {
  const doc = editorEl.ownerDocument;
  const range = doc.createRange();
  const startPosition = utf16OffsetToDom(editorEl, start);
  const endPosition = utf16OffsetToDom(editorEl, end);
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function setCaretOffset(editorEl: HTMLElement, offset: number): void {
  setSelectionOffsets(editorEl, offset, offset);
}

export function getSelectionOffsets(
  editorEl: HTMLElement,
): { start: number; end: number } | null {
  const selection = editorEl.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !editorEl.contains(range.startContainer) ||
    !editorEl.contains(range.endContainer)
  ) {
    return null;
  }
  const start = domOffsetToUtf16(editorEl, range.startContainer, range.startOffset);
  const end = domOffsetToUtf16(editorEl, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function getCaretOffset(editorEl: HTMLElement): number | null {
  const selection = getSelectionOffsets(editorEl);
  return selection ? selection.start : null;
}

/** Expand a selection so that any capsule it touches is included whole. */
function expandSelectionOverCapsules(
  draft: ComposerInlineDraft,
  start: number,
  end: number,
): { start: number; end: number } {
  for (const reference of draft.references) {
    const refEnd = reference.start + reference.value.length;
    if (start < refEnd && end > reference.start) {
      start = Math.min(start, reference.start);
      end = Math.max(end, refEnd);
    }
  }
  return { start, end };
}

export interface InlinePastePayload {
  text: string | null;
  hasImage: boolean;
}

export interface InlinePasteResult {
  /** false when the paste must be handled by the host (e.g. images). */
  handled: boolean;
  draft?: ComposerInlineDraft;
}

/**
 * Apply a text paste at the current selection. A whole-paste URL or absolute
 * path becomes a capsule; anything else is inserted as plain text (with
 * normalized newlines). The selection is replaced; a selection touching a
 * capsule is expanded to swallow the whole capsule.
 */
export function applyInlinePaste(
  editorEl: HTMLElement,
  payload: InlinePastePayload,
  draft: ComposerInlineDraft,
  options: InlineEditorRenderOptions = {},
): InlinePasteResult {
  if (payload.hasImage) {
    return { handled: false };
  }
  const text = normalizeNewlines(payload.text ?? "");
  const selection = getSelectionOffsets(editorEl);
  const position = expandSelectionOverCapsules(
    draft,
    selection?.start ?? 0,
    selection?.end ?? 0,
  );
  const recognized = recognizeReferenceToken(text);
  let updated: ComposerInlineDraft;
  let caret: number;
  if (recognized) {
    const cleared = applyInlineDraftEdit(draft, {
      start: position.start,
      end: position.end,
      inserted: "",
    });
    updated = insertInlineReference(cleared, position.start, recognized);
    caret = position.start + recognized.value.length;
  } else {
    updated = applyInlineDraftEdit(draft, {
      start: position.start,
      end: position.end,
      inserted: text,
    });
    caret = position.start + text.length;
  }
  renderInlineDraft(editorEl, updated, options, caret);
  return { handled: true, draft: updated };
}

/** Thin ClipboardEvent adapter: extract the payload then delegate. */
export function handleInlineEditorPaste(
  editorEl: HTMLElement,
  event: ClipboardEvent,
  draft: ComposerInlineDraft,
  options: InlineEditorRenderOptions = {},
): InlinePasteResult {
  const items = Array.from(event.clipboardData?.items ?? []);
  const hasImage = items.some(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  const text = hasImage ? null : (event.clipboardData?.getData("text/plain") ?? "");
  return applyInlinePaste(editorEl, { text, hasImage }, draft, options);
}

export interface InlineKeydownResult {
  handled: boolean;
  /** Structural model change (capsule removal / selection deletion). */
  draft?: ComposerInlineDraft;
  /** Enter without Shift (and not composing) → host should send. */
  sendRequested?: boolean;
  /** Backspace on a fully empty draft → host should clear the slash token. */
  slashClearRequested?: boolean;
}

/**
 * Keyboard handling: adjacent-capsule Backspace/Delete, selection deletion
 * through the model, arrow-key capsule crossing, Enter-to-send, and IME
 * protection. Anything unhandled falls through to the browser.
 */
export function handleInlineEditorKeydown(
  editorEl: HTMLElement,
  event: KeyboardEvent,
  draft: ComposerInlineDraft,
  options: InlineEditorRenderOptions = {},
): InlineKeydownResult {
  if (event.isComposing) {
    return { handled: false };
  }
  const caret = getCaretOffset(editorEl);
  if (caret === null) {
    return { handled: false };
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    const selection = getSelectionOffsets(editorEl);
    if (selection && selection.start !== selection.end) {
      const expanded = expandSelectionOverCapsules(
        draft,
        selection.start,
        selection.end,
      );
      const updated = applyInlineDraftEdit(draft, {
        start: expanded.start,
        end: expanded.end,
        inserted: "",
      });
      renderInlineDraft(editorEl, updated, options, expanded.start);
      return { handled: true, draft: updated };
    }
    if (event.key === "Backspace") {
      if (draft.text.length === 0 && draft.references.length === 0) {
        return { handled: true, slashClearRequested: true };
      }
      const index = draft.references.findIndex(
        (reference) => reference.start + reference.value.length === caret,
      );
      if (index >= 0) {
        const reference = draft.references[index]!;
        const updated = removeInlineReferenceAt(draft, index);
        renderInlineDraft(editorEl, updated, options, reference.start);
        return { handled: true, draft: updated };
      }
      return { handled: false };
    }
    const index = draft.references.findIndex(
      (reference) => reference.start === caret,
    );
    if (index >= 0) {
      const reference = draft.references[index]!;
      const updated = removeInlineReferenceAt(draft, index);
      renderInlineDraft(editorEl, updated, options, reference.start);
      return { handled: true, draft: updated };
    }
    return { handled: false };
  }

  if (event.key === "ArrowLeft") {
    if (draft.references.some((reference) => reference.start === caret)) {
      let target = caret - 1;
      for (const reference of draft.references) {
        const refEnd = reference.start + reference.value.length;
        if (target > reference.start && target < refEnd) {
          target = reference.start;
        }
      }
      setCaretOffset(editorEl, target);
      return { handled: true };
    }
    return { handled: false };
  }

  if (event.key === "ArrowRight") {
    if (
      draft.references.some(
        (reference) => reference.start + reference.value.length === caret,
      )
    ) {
      let target = caret + 1;
      for (const reference of draft.references) {
        const refEnd = reference.start + reference.value.length;
        if (target > reference.start && target < refEnd) {
          target = refEnd;
        }
      }
      setCaretOffset(editorEl, target);
      return { handled: true };
    }
    return { handled: false };
  }

  if (event.key === "Enter" && !event.shiftKey) {
    return { handled: true, sendRequested: true };
  }

  return { handled: false };
}

/** Remove the capsule at `index` (re-exported helper for the adapter). */
function removeInlineReferenceAt(
  draft: ComposerInlineDraft,
  index: number,
): ComposerInlineDraft {
  const reference = draft.references[index];
  if (!reference) {
    return draft;
  }
  return applyInlineDraftEdit(draft, {
    start: reference.start,
    end: reference.start + reference.value.length,
    inserted: "",
  });
}

/**
 * Clipboard payload for a selection that touches capsules: the FULL original
 * values in text order (the browser would only copy the display labels).
 * Returns null when the browser default is safe.
 */
export function inlineCutPayload(
  editorEl: HTMLElement,
  draft: ComposerInlineDraft,
): string | null {
  const selection = getSelectionOffsets(editorEl);
  if (!selection) {
    return null;
  }
  const touchesCapsule = draft.references.some((reference) => {
    const refEnd = reference.start + reference.value.length;
    return selection.start < refEnd && selection.end > reference.start;
  });
  if (!touchesCapsule) {
    return null;
  }
  return draft.text.slice(selection.start, selection.end);
}

export interface InlineCutResult {
  handled: boolean;
  draft?: ComposerInlineDraft;
  /** The full-value payload the host must put on the clipboard. */
  payload?: string;
}

/** Cut a capsule-touching selection: return the payload and remove it. */
export function applyInlineCut(
  editorEl: HTMLElement,
  draft: ComposerInlineDraft,
  options: InlineEditorRenderOptions = {},
): InlineCutResult {
  const payload = inlineCutPayload(editorEl, draft);
  if (payload === null) {
    return { handled: false };
  }
  const selection = getSelectionOffsets(editorEl)!;
  const expanded = expandSelectionOverCapsules(
    draft,
    selection.start,
    selection.end,
  );
  const updated = applyInlineDraftEdit(draft, {
    start: expanded.start,
    end: expanded.end,
    inserted: "",
  });
  renderInlineDraft(editorEl, updated, options, expanded.start);
  return { handled: true, draft: updated, payload };
}

/**
 * Ordinary input sync: read the DOM back into the model WITHOUT re-rendering,
 * so the browser caret stays exactly where the user left it.
 */
export function handleInlineEditorInput(
  editorEl: HTMLElement,
  draft: ComposerInlineDraft,
): ComposerInlineDraft {
  const read = readInlineDraftFromDom(editorEl);
  return { token: draft.token, text: read.text, references: read.references };
}
