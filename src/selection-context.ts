import { createHash } from "node:crypto";
import { join, normalize } from "node:path";

import type {
  EditorPoint,
  MarkdownDocumentContext,
  SelectionContext,
} from "./types";

export interface DocumentContextInput {
  content: string;
  filePath: string;
  vaultPath: string;
}

export interface SelectionContextInput extends DocumentContextInput {
  from: EditorPoint;
  to: EditorPoint;
}

export interface SelectionEditDiff {
  newText: string;
  oldText?: string | null;
  path: string;
}

export type SelectionEditValidation =
  | { allowed: true }
  | { allowed: false; reason: string };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function clampPoint(lines: string[], point: EditorPoint): EditorPoint {
  const line = clamp(Math.trunc(point.line), 0, Math.max(lines.length - 1, 0));
  const ch = clamp(Math.trunc(point.ch), 0, lines[line]?.length ?? 0);
  return { line, ch };
}

function comparePoints(left: EditorPoint, right: EditorPoint): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.ch - right.ch;
}

function offsetAt(lines: string[], point: EditorPoint): number {
  let offset = point.ch;
  for (let line = 0; line < point.line; line += 1) {
    offset += (lines[line]?.length ?? 0) + 1;
  }
  return offset;
}

function pointAtOffset(content: string, offset: number): EditorPoint {
  const preceding = content.slice(0, offset).split("\n");
  return {
    line: preceding.length - 1,
    ch: preceding[preceding.length - 1]?.length ?? 0,
  };
}

export function locateUniqueTextSelection(
  content: string,
  renderedText: string,
): { from: EditorPoint; text: string; to: EditorPoint } | undefined {
  const text = renderedText.replace(/\u00a0/g, " ").trim();
  if (!text) {
    return undefined;
  }

  const start = content.indexOf(text);
  if (start < 0 || content.indexOf(text, start + text.length) >= 0) {
    return undefined;
  }

  return {
    from: pointAtOffset(content, start),
    text,
    to: pointAtOffset(content, start + text.length),
  };
}

export function createSelectionContext(
  input: SelectionContextInput,
): SelectionContext {
  const lines = input.content.split("\n");
  const first = clampPoint(lines, input.from);
  const second = clampPoint(lines, input.to);
  let from = comparePoints(first, second) <= 0 ? first : second;
  let to = comparePoints(first, second) <= 0 ? second : first;

  if (comparePoints(from, to) === 0) {
    const currentLine = lines[from.line] ?? "";
    from = { line: from.line, ch: 0 };
    to = { line: from.line, ch: currentLine.length };
  }

  const startOffset = offsetAt(lines, from);
  const endOffset = offsetAt(lines, to);
  const selectedText = input.content.slice(startOffset, endOffset);
  const effectiveEndLine =
    to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
  const document = createDocumentContext(input);

  return {
    ...document,
    endLine: effectiveEndLine + 1,
    from,
    selectedText,
    selectionEndOffset: endOffset,
    selectionStartOffset: startOffset,
    startLine: from.line + 1,
    to,
  };
}

export function createDocumentContext(
  input: DocumentContextInput,
): MarkdownDocumentContext {
  return {
    absolutePath: join(input.vaultPath, input.filePath),
    documentContent: input.content,
    documentHash: createHash("sha256").update(input.content).digest("hex"),
    filePath: input.filePath,
  };
}

function block(name: string, content: string): string {
  return `<${name}>\n${content}\n</${name}>`;
}

export function buildSelectionPrompt(
  context: SelectionContext,
  request: string,
): string {
  return [
    "你正在协助用户编辑 Obsidian Markdown 知识库。",
    "",
    `文件：${context.filePath}`,
    `绝对路径：${context.absolutePath}`,
    `选区：第 ${context.startLine}–${context.endLine} 行`,
    `文档快照 SHA-256：${context.documentHash}`,
    "",
    block("document", context.documentContent),
    "",
    block("selection", context.selectedText),
    "",
    `用户请求：${request.trim()}`,
    "",
    "<document> 是当前 Markdown 文件的完整上下文，但只能修改选区（<selection> 对应内容）；选区之前和之后的任何字符都必须保持不变。",
    "如需改写，请只使用 patch(mode=\"replace\") 精确替换选区，不要使用 terminal 或整文件重写；客户端会拒绝越出选区的 diff，并在写入前展示允许范围内的 diff。",
  ].join("\n");
}

export function buildDocumentPrompt(
  context: MarkdownDocumentContext,
  request: string,
): string {
  return [
    "你正在协助用户理解当前 Obsidian Markdown 知识库笔记。",
    "",
    `文件：${context.filePath}`,
    `绝对路径：${context.absolutePath}`,
    `文档快照 SHA-256：${context.documentHash}`,
    "",
    block("document", context.documentContent),
    "",
    `用户请求：${request.trim()}`,
    "",
    "<document> 是当前 Markdown 文件的完整上下文。当前没有附加可编辑选区；你可以修改整个文件（使用 patch 或 write_file 工具）。",
  ].join("\n");
}

export function validateSelectionEdit(
  context: SelectionContext | MarkdownDocumentContext | undefined,
  diffs: SelectionEditDiff[],
): SelectionEditValidation {
  if (!context) {
    return { allowed: false, reason: "No editable file context is attached to this turn." };
  }

  const hasSelection = "selectedText" in context;
  if (diffs.length !== 1) {
    return {
      allowed: false,
      reason: "Inline editing requires exactly one diff for the selected Markdown file.",
    };
  }


  const diff = diffs[0];
  if (!diff) {
    return { allowed: false, reason: "The edit did not include a diff." };
  }
  const requestedPath = normalize(diff.path);
  if (
    requestedPath !== normalize(context.absolutePath) &&
    requestedPath !== normalize(context.filePath)
  ) {
    return { allowed: false, reason: "The edit targets a file other than the selected note." };
  }
  if (diff.oldText !== context.documentContent) {
    return {
      allowed: false,
      reason: "The note changed after the context was captured; refresh and try again.",
    };
  }

  if (!hasSelection) {
    // Document-only context: allow full-file replacement
    return { allowed: true };
  }

  const prefix = context.documentContent.slice(0, (context as SelectionContext).selectionStartOffset);
  const suffix = context.documentContent.slice((context as SelectionContext).selectionEndOffset);
  if (diff.newText.length < prefix.length + suffix.length) {
    return { allowed: false, reason: "The edit removes content outside the selection." };
  }
  if (
    diff.newText.slice(0, prefix.length) !== prefix ||
    diff.newText.slice(diff.newText.length - suffix.length) !== suffix
  ) {
    return { allowed: false, reason: "The edit changes content outside the selection." };
  }
  return { allowed: true };
}
