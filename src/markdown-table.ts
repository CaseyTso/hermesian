type FenceState = {
  character: "`" | "~";
  length: number;
};

/**
 * Insert a single blank line between a non-empty line and a legal GFM table
 * block (header row + delimiter row) that directly follows it, so Obsidian's
 * Markdown renderer recognizes the table instead of rendering pipes as text.
 *
 * - Input that already separates the table with a blank line is left untouched
 *   (the function is idempotent).
 * - Table-like lines inside fenced code (backtick or tilde) are never touched;
 *   a fence only closes on a same-character run of at least the opening length
 *   followed by whitespace only (CommonMark: trailing info text does not close).
 * - Only genuine table blocks are considered: the header row must contain at
 *   least one real pipe (escaped pipes and pipes inside inline code are not
 *   cell separators), the delimiter row cells must be `:?-+:?`, and the
 *   delimiter row must match the header row column count (GFM). Content is
 *   never rewritten.
 */
export function normalizeTableSpacing(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let fence: FenceState | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const character = marker[0] as FenceState["character"];
      if (!fence) {
        fence = { character, length: marker.length };
      } else if (
        fence.character === character &&
        marker.length >= fence.length &&
        /^\s{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)
      ) {
        fence = undefined;
      }
      output.push(line);
      continue;
    }

    if (fence) {
      output.push(line);
      continue;
    }

    if (i + 1 < lines.length && isTablePair(line, lines[i + 1])) {
      const previous = output[output.length - 1];
      if (previous !== undefined && previous.trim() !== "") {
        output.push("");
      }
    }

    output.push(line);
  }

  return output.join("\n");
}

/**
 * True when the two adjacent lines form a legal GFM table header + delimiter
 * pair: a real header row followed by a delimiter row with the same number of
 * cells.
 */
function isTablePair(headerLine: string, delimiterLine: string): boolean {
  if (isIndentedCode(headerLine) || isIndentedCode(delimiterLine)) {
    return false;
  }
  const header = parseRow(headerLine);
  const delimiter = parseRow(delimiterLine);
  if (header === null || delimiter === null) {
    return false;
  }
  // A delimiter row is not a header row.
  if (header.cells.every((cell) => isDelimiterCell(cell))) {
    return false;
  }
  if (!delimiter.cells.every((cell) => isDelimiterCell(cell))) {
    return false;
  }
  // GFM: the delimiter row must match the header row column count.
  return header.cells.length === delimiter.cells.length;
}

function isDelimiterCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell.trim());
}

/**
 * Split a line into table cells on real pipe separators, or return null when
 * the line is not a table row (no real pipes). Escaped pipes (`\|`) and pipes
 * inside inline code spans (`` ` ``) do not separate cells. An optional
 * leading/trailing pipe is stripped, so `| a | b |` and `a | b` both yield
 * two cells.
 */
function parseRow(line: string): { cells: string[] } | null {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cell = "";
  let separatorCount = 0;
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i];

    if (ch === "\\") {
      cell += ch;
      i += 1;
      if (i < trimmed.length) {
        cell += trimmed[i];
        i += 1;
      }
      continue;
    }

    if (ch === "`") {
      const runLength = countRun(trimmed, i, "`");
      const marker = "`".repeat(runLength);
      const closingIndex = trimmed.indexOf(marker, i + runLength);
      if (closingIndex === -1) {
        // Unterminated: the backticks are literal, keep scanning.
        cell += trimmed.slice(i, i + runLength);
        i += runLength;
        continue;
      }
      const end = closingIndex + runLength;
      cell += trimmed.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "|") {
      if (cells.length === 0 && cell === "" && separatorCount === 0) {
        // Leading pipe: not a separator, not a cell.
      } else {
        cells.push(cell);
        cell = "";
        separatorCount += 1;
      }
      i += 1;
      continue;
    }

    cell += ch;
    i += 1;
  }

  if (separatorCount === 0) {
    return null;
  }

  if (!(cell === "" && endsWithRealPipe(trimmed))) {
    cells.push(cell);
  }

  return { cells };
}

function countRun(text: string, start: number, character: string): number {
  let length = 0;
  while (text[start + length] === character) {
    length += 1;
  }
  return length;
}

function endsWithRealPipe(trimmed: string): boolean {
  if (!trimmed.endsWith("|")) {
    return false;
  }
  let backslashes = 0;
  for (let i = trimmed.length - 2; i >= 0 && trimmed[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

/** 4+ leading spaces or a leading tab is an indented code block, not a table. */
function isIndentedCode(line: string): boolean {
  return /^[ \t]{4}/.test(line) || /^\t/.test(line);
}
