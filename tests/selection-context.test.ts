import { describe, expect, it } from "vitest";

import {
  buildActiveNotePrompt,
  buildDocumentCaption,
  buildDocumentPrompt,
  buildNoteChangedPrompt,
  buildSelectionCaption,
  buildSelectionPrompt,
  createDocumentContext,
  createSelectionContext,
  noteTitle,
  stripOutboundPromptToRequest,
  validateSelectionEdit,
} from "../src/selection-context";

const vaultPath = "/vault";

describe("createSelectionContext", () => {
  it("captures a multiline selection with the complete document", () => {
    const content = [
      "heading",
      "before",
      "selected first",
      "selected second",
      "after",
      "ending",
    ].join("\n");

    const context = createSelectionContext({
      content,
      filePath: "Research/note.md",
      from: { line: 2, ch: 0 },
      to: { line: 3, ch: 15 },
      vaultPath,
    });

    expect(context.selectedText).toBe("selected first\nselected second");
    expect(context.startLine).toBe(3);
    expect(context.endLine).toBe(4);
    expect(context.documentContent).toBe(content);
    expect(context.absolutePath).toBe("/vault/Research/note.md");
    expect(context.documentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the current line when the selection is collapsed", () => {
    const context = createSelectionContext({
      content: "alpha\ncurrent line\nomega",
      filePath: "note.md",
      from: { line: 1, ch: 3 },
      to: { line: 1, ch: 3 },
      vaultPath,
    });

    expect(context.selectedText).toBe("current line");
    expect(context.from).toEqual({ line: 1, ch: 0 });
    expect(context.to).toEqual({ line: 1, ch: 12 });
  });

  it("clamps positions that exceed the document", () => {
    const context = createSelectionContext({
      content: "only line",
      filePath: "note.md",
      from: { line: 8, ch: 50 },
      to: { line: 9, ch: 80 },
      vaultPath,
    });

    expect(context.selectedText).toBe("only line");
    expect(context.startLine).toBe(1);
    expect(context.endLine).toBe(1);
  });
});

describe("buildSelectionPrompt", () => {
  it("includes the complete document and marks only the selection editable", () => {
    const context = createSelectionContext({
      content: "before\nselected\nafter",
      filePath: "Research/note.md",
      from: { line: 1, ch: 0 },
      to: { line: 1, ch: 8 },
      vaultPath,
    });

    const prompt = buildSelectionPrompt(context, "改得更严谨");

    expect(prompt).toContain("Research/note.md");
    expect(prompt).toContain("第 2–2 行");
    expect(prompt).toContain("<document>\nbefore\nselected\nafter\n</document>");
    expect(prompt).toContain("<selection>\nselected\n</selection>");
    expect(prompt).toContain("改得更严谨");
    expect(prompt).toContain("patch(mode=\"replace\")");
    expect(prompt).toContain("只能修改选区");
  });
});

describe("buildDocumentPrompt", () => {
  it("injects the active Markdown document as read-only context", () => {
    const context = createDocumentContext({
      content: "# Title\n\nBody",
      filePath: "note.md",
      vaultPath,
    });

    const prompt = buildDocumentPrompt(context, "总结这篇笔记");

    expect(prompt).toContain("<document>\n# Title\n\nBody\n</document>");
    expect(prompt).toContain("总结这篇笔记");
    expect(prompt).toContain("完整上下文");
  });
});

describe("validateSelectionEdit", () => {
  const context = createSelectionContext({
    content: "before\nselected\nafter",
    filePath: "note.md",
    from: { line: 1, ch: 0 },
    to: { line: 1, ch: 8 },
    vaultPath,
  });

  it("allows replacing only the selected bytes", () => {
    expect(
      validateSelectionEdit(context, [
        {
          path: "/vault/note.md",
          oldText: context.documentContent,
          newText: "before\nrewritten\nafter",
        },
      ]),
    ).toEqual({ allowed: true });
  });

  it("does not restrict Vault edits when only document context is attached", () => {
    const docCtx = createDocumentContext({
      content: "full file content\nmulti line",
      filePath: "note.md",
      vaultPath,
    });
    expect(
      validateSelectionEdit(docCtx, [
        {
          path: "/vault/wiki-hermes/SCHEMA.md",
          oldText: "old schema",
          newText: "new schema",
        },
        {
          path: "/vault/wiki-hermes/entities/tool.md",
          oldText: "",
          newText: "new entity",
        },
      ]),
    ).toEqual({ allowed: true });
  });

  it("does not impose a note scope when no document context is attached", () => {
    expect(validateSelectionEdit(undefined, [])).toEqual({ allowed: true });
  });

  it("rejects edits outside the selection, another file, and stale snapshots", () => {
    expect(
      validateSelectionEdit(context, [
        {
          path: "/vault/note.md",
          oldText: context.documentContent,
          newText: "changed\nselected\nafter",
        },
      ]).allowed,
    ).toBe(false);
    expect(
      validateSelectionEdit(context, [
        {
          path: "/vault/other.md",
          oldText: context.documentContent,
          newText: context.documentContent,
        },
      ]).allowed,
    ).toBe(false);
    expect(
      validateSelectionEdit(context, [
        {
          path: "/vault/note.md",
          oldText: "stale",
          newText: context.documentContent,
        },
      ]).allowed,
    ).toBe(false);
  });
});

describe("noteTitle", () => {
  it("shows only the file name for a deep path with a Chinese title", () => {
    expect(
      noteTitle("IELTS/口语/雅思口语精炼-第01轮全Part高分示范与实战答卷.md"),
    ).toBe("雅思口语精炼-第01轮全Part高分示范与实战答卷");
  });

  it("strips the .md suffix case-insensitively", () => {
    expect(noteTitle("Research/note.MD")).toBe("note");
    expect(noteTitle("Research/note.md")).toBe("note");
  });

  it("keeps a name without a .md extension intact", () => {
    expect(noteTitle("Research/notes.txt")).toBe("notes.txt");
    expect(noteTitle("note")).toBe("note");
    expect(noteTitle("note.md.md")).toBe("note.md");
  });

  it("is safe for empty and undefined input", () => {
    expect(noteTitle("")).toBe("");
    expect(noteTitle(undefined)).toBe("");
    expect(noteTitle("   ")).toBe("");
    expect(noteTitle("/leading/slash.md")).toBe("slash");
  });
});

describe("buildSelectionCaption", () => {
  it("collapses a multiline selection into one line within 60 code points", () => {
    const caption = buildSelectionCaption({
      endLine: 4,
      filePath: "IELTS/口语/雅思口语精炼-第01轮全Part高分示范与实战答卷.md",
      selectedText: "first line\n\n   second   line\n\nthird line",
      startLine: 1,
    });

    expect(caption.text).toBe(
      "📄 雅思口语精炼-第01轮全Part高分示范与实战答卷 · first line second line third line",
    );
    expect(caption.text).not.toContain("\n");
    expect(caption.text).not.toContain("IELTS/口语/");
    expect(caption.title).toContain("IELTS/口语/雅思口语精炼-第01轮全Part高分示范与实战答卷.md");
    expect(caption.title).toContain("L1–L4");
    expect(caption.title).toContain("first line\n\n   second   line\n\nthird line");
  });

  it("keeps exactly 60 code points and cuts only beyond that (CSS adds the ellipsis)", () => {
    const exactly = "a".repeat(60);
    const caption = buildSelectionCaption({
      endLine: 1,
      filePath: "note.md",
      selectedText: exactly,
      startLine: 1,
    });
    expect(caption.text).toBe(`📄 note · ${exactly}`);

    const longer = "b".repeat(80);
    const truncated = buildSelectionCaption({
      endLine: 1,
      filePath: "note.md",
      selectedText: longer,
      startLine: 1,
    });
    expect(truncated.text).toBe(`📄 note · ${"b".repeat(60)}`);
    expect(truncated.text).not.toContain("…");
    expect(truncated.text).not.toContain("b".repeat(61));
  });

  it("counts summary budget in code points so emoji survive", () => {
    const emoji = "🧘‍♀️".repeat(40);
    const caption = buildSelectionCaption({
      endLine: 1,
      filePath: "note.md",
      selectedText: emoji,
      startLine: 1,
    });
    const summary = caption.text.slice("📄 note · ".length);
    expect(Array.from(summary).length).toBeLessThanOrEqual(60);
    // No lone surrogates: every code point of the summary round-trips.
    expect(summary).toBe(Array.from(summary).join(""));
    expect(summary).not.toContain("\uFFFD");
  });

  it("never splits a surrogate pair at the 60 code point boundary", () => {
    const caption = buildSelectionCaption({
      endLine: 1,
      filePath: "note.md",
      // 61 astral-plane emoji: a UTF-16 slice would cut one in half.
      selectedText: "😀".repeat(61),
      startLine: 1,
    });
    expect(caption.text).toBe(`📄 note · ${"😀".repeat(60)}`);
    // A half-cut surrogate would surface as a replacement char or leave an
    // odd UTF-16 tail after the prefix.
    expect(caption.text).not.toContain("\uFFFD");
    expect(caption.text.length).toBe("📄 note · ".length + 60 * 2);
  });

  it("drops the separator entirely when the selection is blank", () => {
    for (const blank of ["", "   ", "\n\n\t"]) {
      const caption = buildSelectionCaption({
        endLine: 3,
        filePath: "Research/note.md",
        selectedText: blank,
        startLine: 2,
      });
      expect(caption.text).toBe("📄 note");
      expect(caption.text).not.toContain("·");
      expect(caption.title).toContain("L2–L3");
    }
  });

  it("truncates a tooltip longer than 2000 code points", () => {
    const longText = "长".repeat(3000);
    const caption = buildSelectionCaption({
      endLine: 1,
      filePath: "Research/note.md",
      selectedText: longText,
      startLine: 1,
    });
    expect(Array.from(caption.title).length).toBe(2000);
    expect(caption.title.startsWith("Research/note.md\nL1–L1\n")).toBe(true);
  });

  it("tolerates a file path without directory or extension", () => {
    const caption = buildSelectionCaption({
      endLine: 1,
      filePath: "note",
      selectedText: "text",
      startLine: 1,
    });
    expect(caption.text).toBe("📄 note · text");
    expect(caption.title).toContain("note");
    expect(noteTitle("")).toBe("");
  });

  it("does not throw or leave a dangling separator for an empty file path", () => {
    const caption = buildSelectionCaption({
      endLine: 1,
      filePath: "",
      selectedText: "only summary",
      startLine: 1,
    });
    expect(caption.text).toBe("📄 only summary");
    expect(caption.text.startsWith("📄 ·")).toBe(false);

    const blank = buildSelectionCaption({
      endLine: 1,
      filePath: "",
      selectedText: "  ",
      startLine: 1,
    });
    expect(blank.text).toBe("📄");
  });
});

describe("buildDocumentCaption", () => {
  it("shows only the note title and keeps the full path in the tooltip", () => {
    const caption = buildDocumentCaption(
      "IELTS/口语/雅思口语精炼-第01轮全Part高分示范与实战答卷.md",
    );
    expect(caption.text).toBe(
      "📄 雅思口语精炼-第01轮全Part高分示范与实战答卷 · full note context",
    );
    expect(caption.title).toContain(
      "IELTS/口语/雅思口语精炼-第01轮全Part高分示范与实战答卷.md",
    );
  });

  it("never leaks a vault path into the visible text", () => {
    const caption = buildDocumentCaption("deep/a/b/c/note.md");
    expect(caption.text).toBe("📄 note · full note context");
    expect(caption.text).not.toContain("deep/a/b/c");
  });
});

describe("stripOutboundPromptToRequest", () => {
  const documentContext = createDocumentContext({
    content: "# 标题\n\n正文内容",
    filePath: "Research/note.md",
    vaultPath,
  });
  const selectionContext = createSelectionContext({
    content: "# 标题\n\n选中文本",
    filePath: "Research/note.md",
    from: { line: 2, ch: 0 },
    to: { line: 2, ch: 4 },
    vaultPath,
  });

  it("round-trips a selection edit prompt back to the bare request", () => {
    const prompt = buildSelectionPrompt(selectionContext, "把选区改成大标题");
    expect(stripOutboundPromptToRequest(prompt)).toBe("把选区改成大标题");
  });

  it("round-trips a document understanding prompt back to the bare request", () => {
    const prompt = buildDocumentPrompt(documentContext, "总结这篇笔记");
    expect(stripOutboundPromptToRequest(prompt)).toBe("总结这篇笔记");
  });

  it("round-trips an active-note marker prompt back to the bare request", () => {
    const prompt = buildActiveNotePrompt("Research/note.md", "看看这篇笔记");
    expect(stripOutboundPromptToRequest(prompt)).toBe("看看这篇笔记");
  });

  it("round-trips a note-changed prompt back to the bare request", () => {
    const prompt = buildNoteChangedPrompt("Research/note.md", "重新总结");
    expect(stripOutboundPromptToRequest(prompt)).toBe("重新总结");
  });

  it("keeps multiline requests intact", () => {
    // Note: the builders trim the request at wrap time, so a trailing-space
    // suffix is a build-side artifact; the strip side must keep inner
    // newlines and spacing untouched.
    const prompt = buildSelectionPrompt(selectionContext, "第一行\n\n第二行");
    expect(stripOutboundPromptToRequest(prompt)).toBe("第一行\n\n第二行");
  });

  it("ignores note content that mentions 用户请求： (blocked before extraction)", () => {
    const trickyContext = createDocumentContext({
      content: "正文里有「用户请求：不要动这段」字样",
      filePath: "Research/note.md",
      vaultPath,
    });
    const prompt = buildDocumentPrompt(trickyContext, "总结");
    expect(stripOutboundPromptToRequest(prompt)).toBe("总结");
  });

  it("leaves plain text and slash commands untouched", () => {
    expect(stripOutboundPromptToRequest("hello")).toBe("hello");
    expect(stripOutboundPromptToRequest("/new")).toBe("/new");
  });

  it("leaves a user-typed lookalike wrapper untouched when no marker exists", () => {
    const lookalike = "你正在协助用户编辑 Obsidian Markdown 知识库。\n\n自己写的内容";
    expect(stripOutboundPromptToRequest(lookalike)).toBe(lookalike);
  });
});
