import { createHash } from "node:crypto";
import { join } from "node:path";

import { buildSlashOutboundPrompt } from "./slash-menu";

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

export interface NoteContextCaption {
  /** Visible label, e.g. "📄 雅思口语精炼-第01轮全Part高分示范与实战答卷 · Self-discipline isn't just about willpower; it".
   *  Overflow past the 60-code-point summary is cut by CSS ellipsis, never by
   *  an appended character. */
  text: string;
  /** Hover tooltip: full vault path plus (for a selection) the line range and
   *  the complete selected text. */
  title: string;
}

export interface SelectionCaptionInput {
  endLine: number;
  filePath: string;
  selectedText: string;
  startLine: number;
}

/** Visible summary budget, counted in code points so emoji never split. */
const CAPTION_SUMMARY_MAX_CODE_POINTS = 60;
/** Native `title` tooltips degrade badly past this length. */
const CAPTION_TOOLTIP_MAX_CODE_POINTS = 2000;

function takeCodePoints(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : codePoints.slice(0, max).join("");
}

/** Joins the caption parts with the fixed separator, dropping empty parts so a
 *  blank title or summary never leaves a dangling ` · `. */
function joinCaptionParts(parts: readonly string[]): string {
  const visible = parts.filter(Boolean);
  return visible.length === 0 ? "📄" : `📄 ${visible.join(" · ")}`;
}

/**
 * Markdown note title: only the basename without its `.md` suffix is visible.
 * Other active files (PDF, images, and so on) retain their full basename.
 */
export function activeFileTitle(filePath: string | undefined): string {
  const raw = (filePath ?? "").trim();
  if (!raw) {
    return "";
  }
  const segments = raw.split("/");
  const basename = segments[segments.length - 1] ?? "";
  return raw.toLowerCase().endsWith(".md")
    ? basename.replace(/\.md$/i, "") || basename
    : basename;
}

export const noteTitle = activeFileTitle;

export function buildSelectionCaption(
  selection: SelectionCaptionInput,
): NoteContextCaption {
  const summary = takeCodePoints(
    (selection.selectedText ?? "").replace(/\s+/g, " ").trim(),
    CAPTION_SUMMARY_MAX_CODE_POINTS,
  );
  return {
    text: joinCaptionParts([noteTitle(selection.filePath), summary]),
    title: takeCodePoints(
      [
        selection.filePath,
        `L${selection.startLine}–L${selection.endLine}`,
        selection.selectedText ?? "",
      ].join("\n"),
      CAPTION_TOOLTIP_MAX_CODE_POINTS,
    ),
  };
}

export function buildDocumentCaption(filePath: string): NoteContextCaption {
  return {
    text: joinCaptionParts([noteTitle(filePath)]),
    title: takeCodePoints(filePath, CAPTION_TOOLTIP_MAX_CODE_POINTS),
  };
}

export function buildSelectionPrompt(
  context: SelectionContext,
  request: string,
): string {
  return [
    "你正在通过 Hermesian 协助用户处理 Obsidian Markdown 知识库中的选区内容。",
    "",
    `文件：${context.filePath}`,
    `绝对路径：${context.absolutePath}`,
    `选区：第 ${context.startLine}–${context.endLine} 行`,
    "",
    block("selection", context.selectedText),
    "",
    `用户请求：${request.trim()}`,
    "",
    "<selection> 是用户当前聚焦并提问的片段；如需查看该笔记的其它上下文，请按上述路径自行读取。如有修改需求，不限于只改 <selection>，可按用户要求修改本笔记的其它位置或其它笔记。",
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

export function buildActiveNotePrompt(
  filePath: string | undefined,
  request: string,
  absolutePath?: string,
): string {
  return [
    "你正在通过 Hermesian 协助用户使用 Obsidian。",
    "",
    "<obsidian_context>",
    `active_note: ${filePath ?? "none"}`,
    ...(absolutePath ? [`absolute_path: ${absolutePath}`] : []),
    "document_included: false",
    "</obsidian_context>",
    "",
    `用户请求：${request.trim()}`,
  ].join("\n");
}

export type NoteContextInjectionKind = "full" | "changed" | "none";

/**
 * Display-only inverse of the outbound context wrappers built above
 * (selection / document / active-note / note-changed, including legacy formats).
 * Resume/load history stores the full wrapped prompt; rendering must show only
 * the bare user request. Only exact build products are unwrapped — anything
 * that does not start with one of the fixed prefixes (plain text, slash
 * commands, steer corrections, user-typed lookalikes) is returned untouched.
 */
const OUTBOUND_PREFIXES = [
  "你正在通过 Hermesian 协助用户处理 Obsidian Markdown 知识库中的选区内容。\n\n",
  "你正在协助用户编辑 Obsidian Markdown 知识库。\n\n",
  "你正在协助用户理解当前 Obsidian Markdown 知识库笔记。\n\n",
  "你正在通过 Hermesian 协助用户使用 Obsidian。\n\n",
] as const;

const NOTE_CHANGED_EXPLANATION =
  "\n\n当前笔记内容在本会话中已经发送过，本轮因笔记已发生变化不再重复发送全文；如需最新内容，请加载 obsidian skill 自行读取当前 active_note。";

function stripOutboundBlock(name: string, text: string): string {
  const open = `<${name}>\n`;
  const close = `\n</${name}>`;
  let out = text;
  let start = out.indexOf(open);
  while (start !== -1) {
    const end = out.indexOf(close, start);
    if (end === -1) {
      break;
    }
    out = out.slice(0, start) + out.slice(end + close.length);
    start = out.indexOf(open);
  }
  return out;
}

export function stripOutboundPromptToRequest(text: string): string {
  const prefix = OUTBOUND_PREFIXES.find((candidate) => text.startsWith(candidate));
  if (!prefix) {
    return text;
  }
  let rest = text.slice(prefix.length);
  // Remove tagged blocks first so note/selection content cannot contain the
  // request marker or confuse the extraction.
  rest = stripOutboundBlock("document", rest);
  rest = stripOutboundBlock("selection", rest);
  rest = stripOutboundBlock("obsidian_context", rest);
  if (rest.includes(NOTE_CHANGED_EXPLANATION)) {
    rest = rest.replace(NOTE_CHANGED_EXPLANATION, "");
  }
  // The injected marker is the first paragraph-level occurrence after the
  // blocks are gone; everything after it is the user request plus fixed tails.
  const markerIndex = rest.indexOf("\n用户请求：");
  if (markerIndex === -1) {
    return text;
  }
  let request = rest.slice(markerIndex + "\n用户请求：".length);
  // Fixed edit-scope/read-only/selection-focus trailers may appear after the
  // user request; cut at the earliest recognizable paragraph marker.
  const trailerMarkers = [
    "\n\n<document> 是当前 Markdown 文件的完整上下文",
    "\n\n<selection> 是用户当前聚焦并提问的片段",
  ];
  let trailerIndex = -1;
  for (const marker of trailerMarkers) {
    const idx = request.indexOf(marker);
    if (idx !== -1 && (trailerIndex === -1 || idx < trailerIndex)) {
      trailerIndex = idx;
    }
  }
  if (trailerIndex !== -1) {
    request = request.slice(0, trailerIndex);
  }
  // Only strip trailing newlines (separators that may remain after unwrap),
  // never trailing spaces that belong to the user's request text.
  return request.replace(/\n+$/, "");
}

export interface NoteContextFingerprint {
  filePath: string;
  documentHash: string;
}

export interface ResolveNoteContextInput {
  previous?: NoteContextFingerprint;
  currentPath?: string;
  currentHash?: string;
}

/**
 * Per-tab note-context dedupe decision. With no previous fingerprint the full
 * document must go out; a path change always re-sends the full document; the
 * same path with a different hash only announces the change (the agent may
 * re-read the note via the obsidian skill); identical path+hash sends nothing.
 * A missing current path can never be injected.
 */
export function resolveNoteContextInjection(
  input: ResolveNoteContextInput,
): NoteContextInjectionKind {
  if (!input.currentPath) {
    return "none";
  }
  if (!input.previous) {
    return "full";
  }
  if (input.previous.filePath !== input.currentPath) {
    return "full";
  }
  if ((input.previous.documentHash ?? "") !== (input.currentHash ?? "")) {
    return "changed";
  }
  return "none";
}

export function buildNoteChangedPrompt(
  filePath: string | undefined,
  request: string,
): string {
  return [
    "你正在通过 Hermesian 协助用户使用 Obsidian。",
    "",
    "<obsidian_context>",
    `active_note: ${filePath ?? "none"}`,
    "document_included: false",
    "note_changed: true",
    "</obsidian_context>",
    "",
    "当前笔记内容在本会话中已经发送过，本轮因笔记已发生变化不再重复发送全文；如需最新内容，请加载 obsidian skill 自行读取当前 active_note。",
    "",
    `用户请求：${request.trim()}`,
  ].join("\n");
}

export interface OutboundPromptInput {
  request: string;
  /** Native control command or free-typed slash text: passed through bare. */
  isSlashCommand: boolean;
  /** Menu-selected skill invocation: routed like an ordinary model request. */
  isSkill?: boolean;
  includeCurrentDocumentContext: boolean;
  selection?: SelectionContext;
  documentContext?: MarkdownDocumentContext;
  /** Only ever supplied when the context capsule is on; the off-state send
   *  path never obtains the current note's path, so it cannot leak it. */
  activeNotePath?: string;
  /** Disk absolute path corresponding to activeNotePath, supplied only when
   *  the context capsule is on. */
  activeNoteAbsolutePath?: string;
  /** Deprecated: kept optional for legacy callers; capsule-on turns now always
   *  inject only the active note paths on every turn. */
  noteContextInjection?: NoteContextInjectionKind;
}

/**
 * Single routing point for the production send path (HermesianView.sendMessage).
 *
 * A menu-selected skill is first converted into an ordinary model request
 * (the skill load instruction replaces the raw `/skill <name> …` prefix),
 * then routed through the same branches as any other request: an explicit
 * selection wins (passing path, line range, and `<selection>` without full
 * document body); the off state with no selection passes through without any
 * note context; the on state with no selection injects the active note's
 * relative and absolute paths on every turn without reading or embedding the
 * document body.
 *
 * Native control commands (and free-typed slash text) stay bare — the skill
 * flag wins over the bare-slash flag so a skill can never lose its context.
 */
export function buildOutboundPrompt(input: OutboundPromptInput): string {
  if (input.isSlashCommand && !input.isSkill) {
    return input.request;
  }
  const request = input.isSkill
    ? buildSlashOutboundPrompt(input.request)
    : input.request;
  if (input.selection) {
    return buildSelectionPrompt(input.selection, request);
  }
  if (!input.includeCurrentDocumentContext) {
    return request;
  }
  const filePath = input.activeNotePath ?? input.documentContext?.filePath;
  const absolutePath =
    input.activeNoteAbsolutePath ?? input.documentContext?.absolutePath;
  return buildActiveNotePrompt(filePath, request, absolutePath);
}

export function validateSelectionEdit(
  _context: SelectionContext | MarkdownDocumentContext | undefined,
  _diffs: SelectionEditDiff[],
): SelectionEditValidation {
  // Selection is conversational focus only; vault-wide path validation and
  // user approval happen in the ACP client permission flow.
  return { allowed: true };
}
