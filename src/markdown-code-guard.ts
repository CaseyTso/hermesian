/**
 * Keeps code in agent output from being run by plugins that hook into note
 * rendering.
 *
 * Agent messages are rendered by Obsidian's note renderer, so every Markdown
 * post-processor sees them. Dataview reads any `<code>` whose text starts with
 * `=` as an inline query (`$=` as inline JavaScript) and executes `dataview` /
 * `dataviewjs` fenced blocks. An agent that only mentions Obsidian's
 * `==highlight==` syntax as inline code therefore gets a "Dataview (inline
 * field ...)" error block appended, and any `$=` code is executed.
 *
 * Guarded code is swapped for an inert placeholder before rendering and put
 * back as plain DOM afterwards, when no post-processor runs anymore:
 *
 * - inline code starting with `=` or `$=` becomes an empty `<span>`, found
 *   again by its class or its data attribute, whichever the renderer keeps
 * - a fenced block starting with `=` or `$=`, or tagged `dataview` /
 *   `dataviewjs`, becomes an HTML comment on its own line
 *
 * Only code a post-processor would act on is guarded; everything else still
 * reaches Obsidian untouched. Code the guard cannot see is left exactly as it
 * is today: indented code blocks, inline code spanning lines, and fences
 * indented deeper than three spaces.
 *
 * Restoring never drops code: a placeholder that survived as plain text — the
 * guard misjudged a code span — gets the original Markdown back verbatim, and
 * a placeholder that vanished altogether has its code appended to the message.
 */

export type GuardedCodeKind = "inline" | "block";

export interface GuardedCodeFragment {
  /** Nonce-qualified identifier embedded in the placeholder. */
  id: string;
  kind: GuardedCodeKind;
  /** Exact Markdown that was removed from the message. */
  source: string;
  /** Text shown inside the restored `<code>` element. */
  text: string;
  /** First word of the fence info string, for fenced blocks that carry one. */
  language?: string;
}

export interface GuardedCodeExtraction {
  processedText: string;
  fragments: GuardedCodeFragment[];
}

const INLINE_PLACEHOLDER_CLASS = "hermesian-code-placeholder";
const INLINE_PLACEHOLDER_ATTRIBUTE = "data-hermesian-code";
const BLOCK_PLACEHOLDER_MARKER = "hermesian-code:";
/** Fenced-block languages that Dataview executes instead of displaying. */
const EXECUTED_BLOCK_LANGUAGES = new Set(["dataview", "dataviewjs"]);
/** NodeFilter.SHOW_TEXT, inlined so the module needs no DOM globals. */
const SHOW_TEXT = 4;

type FenceState = { character: "`" | "~"; length: number };
type FenceOpen = FenceState & { info: string; indent: string };
type TopFence = FenceOpen & { start: number };

/** Blockquote markers and indentation in front of a fence inside a container. */
const CONTAINER_PREFIX = /^[ \t]*(?:>[ \t]?)+[ \t]*/;

/**
 * Replaces code that a note post-processor would run with placeholders.
 * The returned fragments restore the original code with {@link restoreGuardedCode}.
 */
export function extractGuardedCode(markdown: string): GuardedCodeExtraction {
  const lines = markdown.split("\n");
  const nonce = createNonce();
  const fragments: GuardedCodeFragment[] = [];
  const output: string[] = [];
  const pending = { closer: undefined as number | undefined };
  let nestedFence: FenceState | undefined;
  let topFence: TopFence | undefined;
  let changed = false;

  const guard = (kind: GuardedCodeKind, source: string, text: string, language?: string): string => {
    const id = `${nonce}-${fragments.length}`;
    fragments.push(language === undefined ? { id, kind, source, text } : { id, kind, source, text, language });
    changed = true;
    return kind === "inline"
      ? `<span class="${inlinePlaceholderClass(id)}" ${INLINE_PLACEHOLDER_ATTRIBUTE}="${id}"></span>`
      : `<!--${BLOCK_PLACEHOLDER_MARKER}${id}-->`;
  };

  // One extra virtual line past the end closes a fence that was never closed.
  for (let index = 0; index <= lines.length; index += 1) {
    const atEnd = index === lines.length;
    const line = atEnd ? "" : lines[index];
    const content = atEnd ? "" : stripCarriageReturn(line);

    if (topFence) {
      const closed = !atEnd && isClosingFence(content, topFence, true);
      if (!closed && !atEnd) {
        continue;
      }
      // The block ends at the closing fence, or at the end of the message
      // when the fence was never closed.
      const end = closed ? index : lines.length;
      const body = lines
        .slice(topFence.start + 1, end)
        .map(stripCarriageReturn)
        .join("\n");
      const language = fenceLanguage(topFence.info);
      const executed =
        language !== undefined && EXECUTED_BLOCK_LANGUAGES.has(language.toLowerCase());
      if (executed || wouldRunAsQuery(body)) {
        const source = lines.slice(topFence.start, closed ? index + 1 : lines.length).join("\n");
        // The placeholder line stands in for the block, so it inherits the
        // line ending of the block's last line.
        const lastLine = closed ? lines[index] : lines[lines.length - 1];
        const carriageReturn = lastLine !== undefined && lastLine.endsWith("\r") ? "\r" : "";
        output.push(topFence.indent + guard("block", source, body, language) + carriageReturn);
      } else {
        output.push(...lines.slice(topFence.start, closed ? index + 1 : lines.length));
      }
      topFence = undefined;
      nestedFence = undefined;
      continue;
    }

    if (atEnd) {
      break;
    }

    if (nestedFence) {
      output.push(line);
      if (isClosingFence(content, nestedFence, false)) {
        nestedFence = undefined;
      }
      continue;
    }

    if (content.trim() === "") {
      pending.closer = undefined;
      output.push(line);
      continue;
    }

    const fence = parseFenceOpen(content, false);
    if (fence) {
      pending.closer = undefined;
      nestedFence = fence;
      const top = parseFenceOpen(content, true);
      if (top) {
        topFence = { ...top, start: index };
      } else {
        output.push(line);
      }
      continue;
    }

    const guardedLine = guardInlineCode(content, pending, (source, text) => guard("inline", source, text));
    if (guardedLine === content) {
      output.push(line);
    } else {
      output.push(guardedLine + (line.endsWith("\r") ? "\r" : ""));
    }
  }

  return { processedText: changed ? output.join("\n") : markdown, fragments };
}

/**
 * Puts guarded code back into a rendered container as inert `<code>` DOM.
 * Never throws: a fragment that cannot be restored keeps its placeholder.
 */
export function restoreGuardedCode(container: HTMLElement, fragments: GuardedCodeFragment[]): void {
  if (!fragments || fragments.length === 0) {
    return;
  }
  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }
  for (const fragment of fragments) {
    try {
      if (!restoreFragment(container, fragment, doc) && !putSourceBack(container, fragment)) {
        // Last resort: keep the code, even though its place is lost.
        container.appendChild(
          fragment.kind === "inline"
            ? createInlineCode(doc, fragment)
            : createCodeBlock(doc, fragment),
        );
      }
    } catch {
      // Restoring is best effort; it must never break the message.
    }
  }
}

function inlinePlaceholderClass(id: string): string {
  return `${INLINE_PLACEHOLDER_CLASS}-${id}`;
}

/**
 * Guards query-like inline code on one line, following Markdown's own rule
 * for pairing backtick strings: a run only closes with a run of the same
 * length that is not part of a longer run, and an opener without a closer on
 * this line stays open for the next lines of the same paragraph.
 */
function guardInlineCode(
  content: string,
  pending: { closer: number | undefined },
  guard: (source: string, text: string) => string,
): string {
  let result = "";
  let copied = 0;
  let index = 0;

  if (pending.closer !== undefined) {
    const closer = findClosingRun(content, 0, pending.closer);
    if (closer === -1) {
      // The whole line sits inside inline code opened on an earlier line.
      return content;
    }
    index = closer + pending.closer;
    pending.closer = undefined;
  }

  while (index < content.length) {
    const character = content[index];
    if (character === "\\") {
      // A backslash-escaped character is never a backtick string.
      index += 2;
      continue;
    }
    if (character !== "`") {
      index += 1;
      continue;
    }

    let runEnd = index;
    while (content[runEnd] === "`") {
      runEnd += 1;
    }
    const length = runEnd - index;
    const closer = findClosingRun(content, runEnd, length);
    if (closer === -1) {
      pending.closer = length;
      index = runEnd;
      continue;
    }

    const text = codeSpanText(content.slice(runEnd, closer));
    if (wouldRunAsQuery(text)) {
      const end = closer + length;
      result += content.slice(copied, index) + guard(content.slice(index, end), text);
      copied = end;
    }
    index = closer + length;
  }

  return copied === 0 ? content : result + content.slice(copied);
}

/** Index of the next backtick string of exactly `length`, or -1. */
function findClosingRun(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === "`") {
      end += 1;
    }
    if (end - index === length) {
      return index;
    }
    index = end;
  }
  return -1;
}

/** Inline code text as Markdown renders it: one edge space stripped when both exist. */
function codeSpanText(raw: string): string {
  if (raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "") {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * True when Dataview would treat the code as a query. A bare `=` or `$=` is
 * an empty query, which Dataview skips.
 */
function wouldRunAsQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "=" || trimmed === "$=") {
    return false;
  }
  return trimmed.startsWith("=") || trimmed.startsWith("$=");
}

/** Opening fence of a code block; only top-level fences keep their indentation. */
function parseFenceOpen(content: string, topOnly: boolean): FenceOpen | undefined {
  const rest = topOnly ? content : content.replace(CONTAINER_PREFIX, "");
  const match = topOnly
    ? rest.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
    : rest.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return undefined;
  }
  const [, indent, marker, info] = match;
  if (marker.startsWith("`") && info.includes("`")) {
    // The info string of a backtick fence cannot contain backticks.
    return undefined;
  }
  return { character: marker[0] as "`" | "~", length: marker.length, info, indent };
}

function isClosingFence(content: string, fence: FenceState, topOnly: boolean): boolean {
  const rest = topOnly ? content : content.replace(CONTAINER_PREFIX, "");
  const match = topOnly ? rest.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/) : rest.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
  return match !== null && match[1][0] === fence.character && match[1].length >= fence.length;
}

/** First word of the info string when it is usable as a `language-` class. */
function fenceLanguage(info: string): string | undefined {
  const word = info.trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z0-9_+#.-]+$/.test(word) ? word : undefined;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function createNonce(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

function restoreFragment(
  container: HTMLElement,
  fragment: GuardedCodeFragment,
  doc: Document,
): boolean {
  if (fragment.kind === "inline") {
    const placeholders = container.querySelectorAll(
      `span[${INLINE_PLACEHOLDER_ATTRIBUTE}="${fragment.id}"], span.${inlinePlaceholderClass(fragment.id)}`,
    );
    if (placeholders.length === 0) {
      return false;
    }
    placeholders.forEach((placeholder) => {
      placeholder.replaceWith(createInlineCode(doc, fragment));
    });
    return true;
  }

  const comment = findComment(container, `${BLOCK_PLACEHOLDER_MARKER}${fragment.id}`);
  if (!comment) {
    return false;
  }

  const pre = createCodeBlock(doc, fragment);
  const parent = comment.parentElement;
  const target =
    parent && parent !== container && parent.tagName === "P" && holdsOnly(parent, comment)
      ? parent
      : comment;
  target.parentNode?.replaceChild(pre, target);
  return true;
}

function createInlineCode(doc: Document, fragment: GuardedCodeFragment): HTMLElement {
  const code = doc.createElement("code");
  code.textContent = fragment.text;
  return code;
}

/** The shape of a fenced block as Obsidian renders it, minus highlighting. */
function createCodeBlock(doc: Document, fragment: GuardedCodeFragment): HTMLElement {
  const code = doc.createElement("code");
  code.textContent = fragment.text.endsWith("\n") ? fragment.text : `${fragment.text}\n`;
  const pre = doc.createElement("pre");
  if (fragment.language !== undefined) {
    code.className = `language-${fragment.language}`;
    pre.className = `language-${fragment.language}`;
  }
  pre.appendChild(code);
  return pre;
}

function findComment(root: Node, marker: string): Node | undefined {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 8) {
      if (child.nodeValue?.trim() === marker) {
        return child;
      }
    } else if (child.nodeType === 1) {
      const found = findComment(child, marker);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function holdsOnly(parent: Node, node: Node): boolean {
  for (const child of Array.from(parent.childNodes)) {
    if (child === node || (child.nodeType === 3 && (child.nodeValue ?? "").trim() === "")) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Puts the original Markdown back where a placeholder survived as plain text.
 * Returns false when the placeholder is nowhere in the container.
 */
function putSourceBack(container: HTMLElement, fragment: GuardedCodeFragment): boolean {
  const doc = container.ownerDocument;
  if (!doc) {
    return false;
  }
  const literal =
    fragment.kind === "inline"
      ? `<span class="${inlinePlaceholderClass(fragment.id)}" ${INLINE_PLACEHOLDER_ATTRIBUTE}="${fragment.id}"></span>`
      : `<!--${BLOCK_PLACEHOLDER_MARKER}${fragment.id}-->`;
  let replaced = false;
  const walker = doc.createTreeWalker(container, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue;
    if (value === null || !value.includes(literal)) {
      continue;
    }
    node.nodeValue = value.split(literal).join(fragment.source);
    replaced = true;
  }
  return replaced;
}
