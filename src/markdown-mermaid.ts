import type { App } from "obsidian";
import { DiagramSurface } from "./ui/diagram-surface";

export interface MermaidBlock {
  index: number;
  source: string;
  placeholder: string;
}

export interface ReplaceMermaidOptions {
  app?: App;
  clipboard?: { writeText(text: string): Promise<void> };
  iconRenderer?: (element: HTMLElement, iconId: string) => void;
  pngExporter?: (svgContent: string) => Promise<Blob>;
  fileSaver?: (blob: Blob) => Promise<string | null>;
}

/**
 * Matches fenced mermaid code blocks in markdown:
 * - Opening fence: 3 or more backticks (`) or tildes (~), indented by 0-3 spaces
 * - Language tag: "mermaid" (case-insensitive), optionally followed by whitespace/attributes
 * - Diagram source: captured between opening fence line and closing fence line
 * - Closing fence: matching opening fence characters, indented by 0-3 spaces
 */
export const MERMAID_BLOCK_REGEX =
  /(?:^|\r?\n)([ \t]{0,3})(`{3,}|~{3,})[ \t]*mermaid(?=[ \t\r\n]|$)([^\r\n]*)\r?\n([\s\S]*?)\r?\n?[ \t]{0,3}\2[ \t]*(?=\r?\n|$)/gi;

/**
 * Extracts mermaid code blocks from markdown text and replaces them with unique placeholders.
 */
export function extractMermaidBlocks(text: string): {
  processedText: string;
  mermaidBlocks: MermaidBlock[];
} {
  const mermaidBlocks: MermaidBlock[] = [];
  let index = 0;

  const processedText = text.replace(
    MERMAID_BLOCK_REGEX,
    (match, indent: string, _fence: string, _info: string, source: string) => {
      const leadingNewline = match.startsWith("\r\n")
        ? "\r\n"
        : match.startsWith("\n")
          ? "\n"
          : "";
      const placeholder = `<!--HERMESIAN-MERMAID-${index}-->`;

      // If the opening fence was indented, remove up to that many leading spaces from content lines
      let cleanSource = source;
      if (indent && indent.length > 0) {
        const indentRegex = new RegExp(`^[ \\t]{1,${indent.length}}`, "gm");
        cleanSource = source.replace(indentRegex, "");
      }

      mermaidBlocks.push({
        index,
        source: cleanSource.trim(),
        placeholder,
      });

      index++;
      return `${leadingNewline}${placeholder}`;
    },
  );

  return { processedText, mermaidBlocks };
}

function isBlankText(node: Node): boolean {
  return node.nodeType === 3 && (node.nodeValue ?? "").trim() === "";
}

function isOnlyPlaceholderParent(parent: Node, placeholderNode: Node): boolean {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child === placeholderNode) continue;
    if (isBlankText(child)) continue;
    return false;
  }
  return true;
}

function findNode(root: Node, predicate: (node: Node) => boolean): Node | null {
  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes[i];
    if (predicate(child)) {
      return child;
    }
    const found = findNode(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Replaces mermaid placeholders in the rendered DOM container with DiagramSurface instances.
 */
export function replaceMermaidPlaceholders(
  container: HTMLElement,
  blocks: MermaidBlock[],
  appOrOptions?: App | ReplaceMermaidOptions,
): void {
  if (!blocks || blocks.length === 0) {
    return;
  }

  const doc =
    container.ownerDocument ??
    (typeof document !== "undefined" ? document : null);
  if (!doc) {
    return;
  }

  const options: ReplaceMermaidOptions =
    appOrOptions && ("vault" in appOrOptions || "workspace" in appOrOptions)
      ? { app: appOrOptions as App }
      : ((appOrOptions as ReplaceMermaidOptions) ?? {});

  for (const block of blocks) {
    const key = `HERMESIAN-MERMAID-${block.index}`;
    const token = block.placeholder;

    const diagramWrapper = doc.createElement("div");
    diagramWrapper.className = "hermesian-mermaid-container";

    new DiagramSurface({
      container: diagramWrapper,
      source: block.source,
      app: options.app,
      clipboard: options.clipboard,
      iconRenderer: options.iconRenderer,
      pngExporter: options.pngExporter,
      fileSaver: options.fileSaver,
    });

    // 1. Look for a Comment node (nodeType === 8)
    const commentNode = findNode(
      container,
      (node) =>
        node.nodeType === 8 &&
        (node.nodeValue?.trim() === key ||
          Boolean(node.nodeValue && node.nodeValue.includes(key))),
    );

    if (commentNode) {
      let targetNode: Node = commentNode;
      const parent = commentNode.parentElement;
      if (
        parent &&
        parent !== container &&
        parent.tagName.toLowerCase() === "p" &&
        isOnlyPlaceholderParent(parent, commentNode)
      ) {
        targetNode = parent;
      }
      if (targetNode.parentNode) {
        targetNode.parentNode.replaceChild(diagramWrapper, targetNode);
      } else {
        container.appendChild(diagramWrapper);
      }
      continue;
    }

    // 2. Look for a Text node (nodeType === 3)
    const textNode = findNode(
      container,
      (node) =>
        node.nodeType === 3 &&
        Boolean(
          node.nodeValue &&
            (node.nodeValue.includes(token) || node.nodeValue.includes(key)),
        ),
    );

    if (textNode) {
      const val = textNode.nodeValue ?? "";
      const matchToken = val.includes(token)
        ? token
        : val.includes(key)
          ? key
          : token;
      const trimmed = val.trim();

      if (trimmed === matchToken) {
        let targetNode: Node = textNode;
        const parent = textNode.parentElement;
        if (
          parent &&
          parent !== container &&
          parent.tagName.toLowerCase() === "p" &&
          isOnlyPlaceholderParent(parent, textNode)
        ) {
          targetNode = parent;
        }
        if (targetNode.parentNode) {
          targetNode.parentNode.replaceChild(diagramWrapper, targetNode);
        } else {
          container.appendChild(diagramWrapper);
        }
        continue;
      }

      // Split text node if there is other text surrounding the token
      const idx = val.indexOf(matchToken);
      if (idx !== -1) {
        const before = val.slice(0, idx);
        const after = val.slice(idx + matchToken.length);
        const parent = textNode.parentNode;
        if (parent) {
          if (before) {
            parent.insertBefore(doc.createTextNode(before), textNode);
          }
          parent.insertBefore(diagramWrapper, textNode);
          if (after) {
            parent.insertBefore(doc.createTextNode(after), textNode);
          }
          parent.removeChild(textNode);
        } else {
          container.appendChild(diagramWrapper);
        }
        continue;
      }
    }

    // 3. Fallback: placeholder not found in DOM, append to container
    container.appendChild(diagramWrapper);
  }
}
