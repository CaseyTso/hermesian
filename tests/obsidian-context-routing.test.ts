import { describe, expect, it } from "vitest";

import { buildActiveNotePrompt } from "../src/selection-context";

describe("buildActiveNotePrompt", () => {
  it("includes active note file path and declares document_included: false when a note is open", () => {
    const prompt = buildActiveNotePrompt(
      "10 Projects/研究笔记.md",
      "当前选中的笔记是什么",
    );

    expect(prompt).toContain("<obsidian_context>");
    expect(prompt).toContain("active_note: 10 Projects/研究笔记.md");
    expect(prompt).toContain("document_included: false");
    expect(prompt).toContain("</obsidian_context>");
    expect(prompt).toContain("当前选中的笔记是什么");
    // Must NOT leak absolute paths or document content
    expect(prompt).not.toContain("<document>");
    expect(prompt).not.toContain("/Users/");
  });

  it("declares active_note: none when no note is open", () => {
    const prompt = buildActiveNotePrompt(undefined, "当前笔记是什么");

    expect(prompt).toContain("active_note: none");
    expect(prompt).toContain("document_included: false");
    expect(prompt).toContain("当前笔记是什么");
    expect(prompt).not.toContain("<document>");
  });

  it("works with an empty request", () => {
    const prompt = buildActiveNotePrompt("note.md", "");
    expect(prompt).toContain("active_note: note.md");
    expect(prompt).toContain("用户请求：");
  });
});
