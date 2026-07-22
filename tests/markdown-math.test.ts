import { describe, expect, it } from "vitest";

import { normalizeMathDelimiters } from "../src/markdown-math";

describe("normalizeMathDelimiters", () => {
  it("converts MathJax inline and display delimiters for Obsidian Markdown", () => {
    const source = [
      "Inline \\(x^2\\).",
      "",
      "\\[",
      "\\mathrm{SC}_j(i) = \\underbrace{x}_{\\text{value}}",
      "\\]",
    ].join("\n");

    expect(normalizeMathDelimiters(source)).toBe(
      [
        "Inline $x^2$.",
        "",
        "$$",
        "\\mathrm{SC}_j(i) = \\underbrace{x}_{\\text{value}}",
        "$$",
      ].join("\n"),
    );
  });

  it("does not modify inline code or fenced code", () => {
    const source = [
      "`\\\\(not math\\\\)`",
      "```tex",
      "\\[",
      "x",
      "\\]",
      "```",
      "",
      "\\[y\\]",
    ].join("\n");

    expect(normalizeMathDelimiters(source)).toBe(
      [
        "`\\\\(not math\\\\)`",
        "```tex",
        "\\[",
        "x",
        "\\]",
        "```",
        "",
        "$$y$$",
      ].join("\n"),
    );
  });

  it("preserves already supported dollar delimiters", () => {
    const source = "Inline $x^2$ and block:\\n\\n$$\\ny = mx + b\\n$$";
    expect(normalizeMathDelimiters(source)).toBe(source);
  });
});
