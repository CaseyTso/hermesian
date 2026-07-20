export interface ExternalLinkMatch {
  end: number;
  href: string;
  start: number;
  text: string;
}

const URL_PATTERN = /(?<![@\p{L}\p{N}_])(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|top|online|edu|gov|cn)(?::\d{2,5})?(?:\/[^\s<>"'`]*)?)/giu;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、]$/u;

function trimTrailingPunctuation(value: string): string {
  let trimmed = value;
  while (TRAILING_PUNCTUATION.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["（", "）"],
    ["［", "］"],
    ["【", "】"],
  ] as const) {
    while (
      trimmed.endsWith(closing) &&
      trimmed.split(closing).length > trimmed.split(opening).length
    ) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function externalHref(text: string): string | undefined {
  const candidate = /^https?:\/\//iu.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function findExternalLinks(text: string): ExternalLinkMatch[] {
  const matches: ExternalLinkMatch[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const linkText = trimTrailingPunctuation(match[0]);
    const href = externalHref(linkText);
    if (!href || !linkText) {
      continue;
    }
    matches.push({
      end: start + linkText.length,
      href,
      start,
      text: linkText,
    });
  }
  return matches;
}

export function linkifyExternalUrls(root: HTMLElement): void {
  const document = root.ownerDocument;
  const nodeFilter = document.defaultView?.NodeFilter ?? NodeFilter;
  const walker = document.createTreeWalker(root, nodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      textNodes.push(node);
    }
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest("a,script,style,textarea")) {
      continue;
    }
    const matches = findExternalLinks(textNode.data);
    if (matches.length === 0) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      fragment.append(document.createTextNode(textNode.data.slice(cursor, match.start)));
      const anchor = document.createElement("a");
      anchor.className = "external-link";
      anchor.href = match.href;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      anchor.textContent = match.text;
      fragment.append(anchor);
      cursor = match.end;
    }
    fragment.append(document.createTextNode(textNode.data.slice(cursor)));
    textNode.replaceWith(fragment);
  }
}
