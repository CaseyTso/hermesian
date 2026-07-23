type FenceState = {
  character: "`" | "~";
  length: number;
};

/**
 * Convert MathJax-style delimiters emitted by some models to Obsidian's
 * Markdown math delimiters while leaving code spans and fenced code untouched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  let fence: FenceState | undefined;

  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        const character = marker[0] as FenceState["character"];
        if (!fence) {
          fence = { character, length: marker.length };
        } else if (fence.character === character && marker.length >= fence.length) {
          fence = undefined;
        }
        return line;
      }

      return fence ? line : normalizeMathOutsideInlineCode(line);
    })
    .join("\n");
}

function normalizeMathOutsideInlineCode(line: string): string {
  let normalized = "";
  let index = 0;

  while (index < line.length) {
    if (line[index] === "`") {
      const runLength = countRun(line, index, "`");
      const marker = "`".repeat(runLength);
      const closingIndex = line.indexOf(marker, index + runLength);
      if (closingIndex === -1) {
        normalized += line.slice(index);
        break;
      }
      const end = closingIndex + runLength;
      normalized += line.slice(index, end);
      index = end;
      continue;
    }

    const delimiter = line.slice(index, index + 2);
    if ((delimiter === "\\[" || delimiter === "\\]") && !isEscapedBackslash(line, index)) {
      normalized += "$$";
      index += 2;
      continue;
    }
    if ((delimiter === "\\(" || delimiter === "\\)") && !isEscapedBackslash(line, index)) {
      normalized += "$";
      index += 2;
      continue;
    }

    normalized += line[index];
    index += 1;
  }

  return normalized;
}

function countRun(text: string, start: number, character: string): number {
  let length = 0;
  while (text[start + length] === character) {
    length += 1;
  }
  return length;
}

function isEscapedBackslash(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
