import { describe, expect, it } from "vitest";

import {
  buildDocumentPrompt,
  buildSelectionPrompt,
  createDocumentContext,
  createSelectionContext,
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
