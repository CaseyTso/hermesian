/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from "vitest";

import {
  applyInlinePaste,
  domOffsetToUtf16,
  getCaretOffset,
  getSelectionOffsets,
  handleInlineEditorKeydown,
  handleInlineEditorInput,
  inlineCutPayload,
  normalizeNewlines,
  readInlineDraftFromDom,
  renderInlineDraft,
  setCaretOffset,
  setSelectionOffsets,
  utf16OffsetToDom,
} from "../src/composer-inline-editor";
import type { ComposerInlineDraft } from "../src/composer-reference-tokens";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const PATH_C = "/Users/中文 空格/笔记.md";

function draft(overrides: Partial<ComposerInlineDraft> = {}): ComposerInlineDraft {
  return { token: null, text: "", references: [], ...overrides };
}

function setup() {
  const editorEl = document.createElement("div");
  return { editorEl };
}

function capsuleNodes(editorEl: HTMLElement): HTMLElement[] {
  return Array.from(editorEl.querySelectorAll(".hermesian-inline-ref"));
}

describe("normalizeNewlines", () => {
  it("converts CRLF and CR to LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves LF-only text untouched", () => {
    expect(normalizeNewlines("a\nb\nc")).toBe("a\nb\nc");
  });

  it("keeps plain text untouched", () => {
    expect(normalizeNewlines("请总结 这篇文献")).toBe("请总结 这篇文献");
  });
});

describe("renderInlineDraft", () => {
  it("renders plain text as a text node", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "请总结这篇文献" }));
    expect(editorEl.textContent).toBe("请总结这篇文献");
    expect(editorEl.childNodes).toHaveLength(1);
    expect(editorEl.firstChild!.nodeType).toBe(Node.TEXT_NODE);
  });

  it("renders a capsule between surrounding text as an atomic non-editable span", () => {
    const { editorEl } = setup();
    renderInlineDraft(
      editorEl,
      draft({
        text: `前文${URL_A}后文`,
        references: [{ kind: "url", value: URL_A, start: 2 }],
      }),
    );
    // the DOM shows the display projection (host label), the model keeps the full value
    expect(editorEl.textContent).toBe("前文example.com后文");
    expect(readInlineDraftFromDom(editorEl).text).toBe(`前文${URL_A}后文`);
    const capsules = capsuleNodes(editorEl);
    expect(capsules).toHaveLength(1);
    const capsule = capsules[0]!;
    expect(capsule.getAttribute("contenteditable")).toBe("false");
    expect(capsule.classList.contains("is-url")).toBe(true);
    expect(capsule.getAttribute("title")).toBe(URL_A);
    expect(capsule.getAttribute("aria-label")).toBe(`Reference URL ${URL_A}`);
    expect(capsule.querySelector(".hermesian-inline-ref-label")!.textContent).toBe(
      "example.com",
    );
    // the capsule sits between the two text nodes
    expect(editorEl.childNodes).toHaveLength(3);
    expect(editorEl.firstChild!.textContent).toBe("前文");
    expect(editorEl.lastChild!.textContent).toBe("后文");
  });

  it("renders a path capsule with basename label and kind class", () => {
    const { editorEl } = setup();
    renderInlineDraft(
      editorEl,
      draft({
        text: `请处理${PATH_C}`,
        references: [{ kind: "path", value: PATH_C, start: 3 }],
      }),
    );
    const capsule = capsuleNodes(editorEl)[0]!;
    expect(capsule.classList.contains("is-path")).toBe(true);
    expect(capsule.classList.contains("is-url")).toBe(false);
    expect(capsule.querySelector(".hermesian-inline-ref-label")!.textContent).toBe(
      "笔记.md",
    );
    expect(capsule.getAttribute("aria-label")).toBe(`Reference path ${PATH_C}`);
  });

  it("renders newlines as <br> separators", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "第一行\n第二行\n第三行" }));
    expect(editorEl.querySelectorAll("br")).toHaveLength(2);
    // <br> contributes no text content but reads back as \n
    expect(editorEl.textContent).toBe("第一行第二行第三行");
    expect(readInlineDraftFromDom(editorEl).text).toBe("第一行\n第二行\n第三行");
  });

  it("renders duplicate identical URLs as two distinct capsules", () => {
    const { editorEl } = setup();
    renderInlineDraft(
      editorEl,
      draft({
        text: `${URL_A} 与 ${URL_A}`,
        references: [
          { kind: "url", value: URL_A, start: 0 },
          { kind: "url", value: URL_A, start: URL_A.length + 3 },
        ],
      }),
    );
    expect(capsuleNodes(editorEl)).toHaveLength(2);
  });

  it("renders an empty text without child nodes (placeholder surface)", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "" }));
    expect(editorEl.childNodes).toHaveLength(0);
  });

  it("wires a clickable remove button per capsule carrying the full value", () => {
    const { editorEl } = setup();
    const onRemove = vi.fn();
    renderInlineDraft(
      editorEl,
      draft({
        text: URL_A,
        references: [{ kind: "url", value: URL_A, start: 0 }],
      }),
      { onRemoveReference: onRemove },
    );
    const button = capsuleNodes(editorEl)[0]!.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe(`Remove reference URL ${URL_A}`);
    button.click();
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});

describe("readInlineDraftFromDom", () => {
  it("reads back a rendered draft identically (round-trip)", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `先看 ${URL_A}，再看 ${PATH_C}，最后`,
      references: [
        { kind: "url", value: URL_A, start: 3 },
        { kind: "path", value: PATH_C, start: 3 + URL_A.length + 4 },
      ],
    });
    renderInlineDraft(editorEl, original);
    const read = readInlineDraftFromDom(editorEl);
    expect(read).toEqual({
      text: original.text,
      references: original.references,
    });
  });

  it("reads typed text between capsules with correct starts", () => {
    const { editorEl } = setup();
    renderInlineDraft(
      editorEl,
      draft({
        text: `${URL_A}${URL_B}`,
        references: [
          { kind: "url", value: URL_A, start: 0 },
          { kind: "url", value: URL_B, start: URL_A.length },
        ],
      }),
    );
    // simulate typing between the two capsules
    const typed = document.createTextNode("中间");
    editorEl.insertBefore(typed, editorEl.childNodes[1]);
    expect(readInlineDraftFromDom(editorEl)).toEqual({
      text: `${URL_A}中间${URL_B}`,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_B, start: URL_A.length + 2 },
      ],
    });
  });

  it("treats <br> as a newline", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "第一行\n第二行" }));
    expect(readInlineDraftFromDom(editorEl).text).toBe("第一行\n第二行");
  });

  it("rejects DOM without capsule metadata as plain text", () => {
    const { editorEl } = setup();
    editorEl.textContent = "https://example.com/a 普通文本";
    expect(readInlineDraftFromDom(editorEl)).toEqual({
      text: "https://example.com/a 普通文本",
      references: [],
    });
  });

  it("counts emoji as two UTF-16 code units", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `看👀${URL_A}`,
      references: [{ kind: "url", value: URL_A, start: 3 }],
    });
    renderInlineDraft(editorEl, original);
    expect(readInlineDraftFromDom(editorEl)).toEqual({
      text: original.text,
      references: original.references,
    });
  });
});

describe("UTF-16 offset mapping", () => {
  function richEditor(): HTMLElement {
    const { editorEl } = setup();
    renderInlineDraft(
      editorEl,
      draft({
        text: `看👀${URL_A}中`,
        references: [{ kind: "url", value: URL_A, start: 3 }],
      }),
    );
    return editorEl;
  }

  it("maps a caret inside the leading text node", () => {
    const editorEl = richEditor();
    const first = editorEl.firstChild!;
    expect(domOffsetToUtf16(editorEl, first, 1)).toBe(1);
  });

  it("maps a caret at the end of a text node to the boundary before the capsule", () => {
    const editorEl = richEditor();
    const first = editorEl.firstChild!;
    // 看=1, 👀=2 → text node length 3 = capsule start
    expect(domOffsetToUtf16(editorEl, first, 3)).toBe(3);
  });

  it("maps a caret in the trailing text node past the capsule", () => {
    const editorEl = richEditor();
    const last = editorEl.lastChild!;
    expect(domOffsetToUtf16(editorEl, last, 1)).toBe(3 + URL_A.length + 1);
  });

  it("resolves a UTF-16 offset back to a concrete DOM position", () => {
    const editorEl = richEditor();
    const { node, offset } = utf16OffsetToDom(editorEl, 1);
    expect(node).toBe(editorEl.firstChild);
    expect(offset).toBe(1);
    const end = utf16OffsetToDom(editorEl, 3 + URL_A.length);
    expect(end.node).toBe(editorEl.lastChild);
    expect(end.offset).toBe(0);
  });

  it("sets and reads back a caret offset (surrogate pairs included)", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "看👀文" }));
    setCaretOffset(editorEl, 3);
    expect(getCaretOffset(editorEl)).toBe(3);
    setCaretOffset(editorEl, 1);
    expect(getCaretOffset(editorEl)).toBe(1);
  });

  it("sets and reads back a selection range", () => {
    const { editorEl } = setup();
    renderInlineDraft(
      editorEl,
      draft({
        text: `前文${URL_A}后文`,
        references: [{ kind: "url", value: URL_A, start: 2 }],
      }),
    );
    setSelectionOffsets(editorEl, 1, 2 + URL_A.length + 1);
    const selection = getSelectionOffsets(editorEl);
    expect(selection).toEqual({ start: 1, end: 2 + URL_A.length + 1 });
  });
});

describe("applyInlinePaste", () => {
  it("pastes a URL at the caret as a capsule between 前文 and 后文", () => {
    const { editorEl } = setup();
    const original = draft({ text: "前文后文" });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2);
    const result = applyInlinePaste(editorEl, { text: URL_A, hasImage: false }, original);
    expect(result.handled).toBe(true);
    expect(result.draft!.text).toBe(`前文${URL_A}后文`);
    expect(result.draft!.references).toEqual([
      { kind: "url", value: URL_A, start: 2 },
    ]);
    // DOM now shows the capsule in the middle (display projection)
    expect(editorEl.textContent).toBe("前文example.com后文");
    expect(readInlineDraftFromDom(editorEl).text).toBe(`前文${URL_A}后文`);
    expect(capsuleNodes(editorEl)).toHaveLength(1);
    expect(editorEl.firstChild!.textContent).toBe("前文");
    expect(editorEl.lastChild!.textContent).toBe("后文");
    // caret lands right after the inserted capsule
    expect(getCaretOffset(editorEl)).toBe(2 + URL_A.length);
  });

  it("pastes an absolute path as a path capsule", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "请总结" }));
    setCaretOffset(editorEl, 3);
    const result = applyInlinePaste(
      editorEl,
      { text: PATH_C, hasImage: false },
      draft({ text: "请总结" }),
    );
    expect(result.draft!.references).toEqual([
      { kind: "path", value: PATH_C, start: 3 },
    ]);
  });

  it("replaces the current selection with the pasted capsule", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `请总结这篇文献`,
      references: [],
    });
    renderInlineDraft(editorEl, original);
    setSelectionOffsets(editorEl, 2, 5); // select 结这篇
    const result = applyInlinePaste(editorEl, { text: URL_A, hasImage: false }, original);
    expect(result.draft!.text).toBe(`请总${URL_A}文献`);
    expect(result.draft!.references).toEqual([
      { kind: "url", value: URL_A, start: 2 },
    ]);
    expect(editorEl.textContent).toBe(`请总example.com文献`);
  });

  it("expands a selection touching a capsule to include the whole capsule", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    // selection starts inside the capsule and ends in 后文
    setSelectionOffsets(editorEl, 3, 2 + URL_A.length + 1);
    const result = applyInlinePaste(editorEl, { text: PATH_C, hasImage: false }, original);
    expect(result.draft!.text).toBe(`前文${PATH_C}文`);
    expect(result.draft!.references).toEqual([
      { kind: "path", value: PATH_C, start: 2 },
    ]);
  });

  it("pastes multiline text as plain text with normalized newlines", () => {
    const { editorEl } = setup();
    const original = draft({ text: "ab" });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 1);
    const result = applyInlinePaste(
      editorEl,
      { text: "x\r\ny", hasImage: false },
      original,
    );
    expect(result.draft!.text).toBe("ax\nyb");
    expect(result.draft!.references).toEqual([]);
    expect(editorEl.querySelectorAll("br")).toHaveLength(1);
  });

  it("leaves image pastes to the host (handled=false)", () => {
    const { editorEl } = setup();
    const original = draft({ text: "前文后文" });
    renderInlineDraft(editorEl, original);
    const result = applyInlinePaste(editorEl, { text: URL_A, hasImage: true }, original);
    expect(result.handled).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(editorEl.textContent).toBe("前文后文");
  });

  it("keeps prose with an embedded URL as plain text", () => {
    const { editorEl } = setup();
    const original = draft({ text: "请" });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 1);
    const result = applyInlinePaste(
      editorEl,
      { text: `看看 ${URL_A} 如何`, hasImage: false },
      original,
    );
    expect(result.draft!.references).toEqual([]);
    expect(result.draft!.text).toBe(`请看看 ${URL_A} 如何`);
  });
});

describe("handleInlineEditorKeydown", () => {
  function keydown(
    _editorEl: HTMLElement,
    key: string,
    extra: Partial<KeyboardEvent> = {},
  ): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    return event;
  }

  it("Backspace deletes the capsule immediately before the caret", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2 + URL_A.length);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Backspace"), original);
    expect(result.handled).toBe(true);
    expect(result.draft).toEqual(draft({ text: "前文后文" }));
  });

  it("Backspace does not touch the capsule when not adjacent", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 1);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Backspace"), original);
    expect(result.handled).toBe(false);
    expect(result.draft).toBeUndefined();
  });

  it("Delete removes the capsule immediately after the caret", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Delete"), original);
    expect(result.handled).toBe(true);
    expect(result.draft).toEqual(draft({ text: "前文后文" }));
  });

  it("Delete does not touch the capsule when the caret is before preceding text", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2 + URL_A.length + 1);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Delete"), original);
    expect(result.handled).toBe(false);
  });

  it("Backspace on an empty text requests slash-token clear", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "" }));
    setCaretOffset(editorEl, 0);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Backspace"), draft({ text: "" }));
    expect(result.slashClearRequested).toBe(true);
  });

  it("Backspace on non-empty text never requests slash clear", () => {
    const { editorEl } = setup();
    renderInlineDraft(editorEl, draft({ text: "文" }));
    setCaretOffset(editorEl, 1);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Backspace"), draft({ text: "文" }));
    expect(result.slashClearRequested).toBeUndefined();
    expect(result.handled).toBe(false);
  });

  it("ArrowLeft crosses the capsule without splitting it", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2); // just before the capsule
    handleInlineEditorKeydown(editorEl, keydown(editorEl, "ArrowLeft"), original);
    expect(getCaretOffset(editorEl)).toBe(1);
    // still one intact capsule
    expect(capsuleNodes(editorEl)).toHaveLength(1);
    expect(readInlineDraftFromDom(editorEl).text).toBe(`前文${URL_A}后文`);
  });

  it("ArrowRight crosses the capsule without splitting it", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2 + URL_A.length); // just after the capsule
    handleInlineEditorKeydown(editorEl, keydown(editorEl, "ArrowRight"), original);
    expect(getCaretOffset(editorEl)).toBe(2 + URL_A.length + 1);
  });

  it("Enter (no shift, not composing) requests send and is handled", () => {
    const { editorEl } = setup();
    const original = draft({ text: "请总结" });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 3);
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Enter"), original);
    expect(result.sendRequested).toBe(true);
    expect(result.handled).toBe(true);
  });

  it("Shift+Enter stays unhandled (browser inserts a newline)", () => {
    const { editorEl } = setup();
    const original = draft({ text: "请总结" });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 3);
    const result = handleInlineEditorKeydown(
      editorEl,
      keydown(editorEl, "Enter", { shiftKey: true }),
      original,
    );
    expect(result.sendRequested).toBeUndefined();
    expect(result.handled).toBe(false);
  });

  it("IME composing Enter neither sends nor deletes", () => {
    const { editorEl } = setup();
    const original = draft({ text: "请总结" });
    renderInlineDraft(editorEl, original);
    const result = handleInlineEditorKeydown(
      editorEl,
      keydown(editorEl, "Enter", { isComposing: true }),
      original,
    );
    expect(result.sendRequested).toBeUndefined();
    expect(result.handled).toBe(false);
    const backspace = handleInlineEditorKeydown(
      editorEl,
      keydown(editorEl, "Backspace", { isComposing: true }),
      original,
    );
    expect(backspace.handled).toBe(false);
    expect(backspace.draft).toBeUndefined();
  });

  it("Backspace adjacent to a capsule is ignored while composing", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, 2 + URL_A.length);
    const result = handleInlineEditorKeydown(
      editorEl,
      keydown(editorEl, "Backspace", { isComposing: true }),
      original,
    );
    expect(result.handled).toBe(false);
    expect(result.draft).toBeUndefined();
  });

  it("capsule removal by Backspace updates later reference starts", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `${URL_A} 和 ${URL_B}`,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_B, start: URL_A.length + 3 },
      ],
    });
    renderInlineDraft(editorEl, original);
    setCaretOffset(editorEl, URL_A.length); // right after the first capsule
    const result = handleInlineEditorKeydown(editorEl, keydown(editorEl, "Backspace"), original);
    expect(result.draft).toEqual(
      draft({
        text: ` 和 ${URL_B}`,
        references: [{ kind: "url", value: URL_B, start: 3 }],
      }),
    );
  });
});

describe("inlineCutPayload / copy semantics", () => {
  it("extracts the FULL original values for a selection spanning capsules", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setSelectionOffsets(editorEl, 0, 2 + URL_A.length + 2);
    expect(inlineCutPayload(editorEl, original)).toBe(`前文${URL_A}后文`);
  });

  it("leaves selections that avoid capsules to the browser default", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    setSelectionOffsets(editorEl, 0, 1);
    expect(inlineCutPayload(editorEl, original)).toBeNull();
  });

  it("handles a full-select across duplicate identical values", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `${URL_A} 和 ${URL_A}`,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_A, start: URL_A.length + 3 },
      ],
    });
    renderInlineDraft(editorEl, original);
    setSelectionOffsets(editorEl, 0, original.text.length);
    expect(inlineCutPayload(editorEl, original)).toBe(original.text);
  });
});

describe("handleInlineEditorInput", () => {
  it("syncs the model from the DOM after ordinary typing (no full re-render)", () => {
    const { editorEl } = setup();
    const original = draft({
      text: `前文${URL_A}后文`,
      references: [{ kind: "url", value: URL_A, start: 2 }],
    });
    renderInlineDraft(editorEl, original);
    // simulate typing one character after the capsule
    const typed = document.createTextNode("！");
    editorEl.appendChild(typed);
    const next = handleInlineEditorInput(editorEl, original);
    expect(next.text).toBe(`前文${URL_A}后文！`);
    expect(next.references).toEqual([
      { kind: "url", value: URL_A, start: 2 },
    ]);
  });

  it("keeps the DOM in place (no re-render) so the caret is undisturbed", () => {
    const { editorEl } = setup();
    const original = draft({ text: "请总结" });
    renderInlineDraft(editorEl, original);
    const nodeBefore = editorEl.firstChild;
    const next = handleInlineEditorInput(editorEl, original);
    expect(next.text).toBe("请总结");
    expect(editorEl.firstChild).toBe(nodeBefore);
  });
});
