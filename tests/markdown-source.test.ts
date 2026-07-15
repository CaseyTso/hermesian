import { describe, expect, it } from "vitest";

import { chooseMarkdownSource } from "../src/markdown-source";
import { locateUniqueTextSelection } from "../src/selection-context";

describe("chooseMarkdownSource", () => {
  it("uses the most recent Markdown view after the sidebar becomes active", () => {
    const recent = { id: "recent-markdown" };
    expect(chooseMarkdownSource(undefined, undefined, recent)).toBe(recent);
  });

  it("prefers an explicit or currently active Markdown view", () => {
    const explicit = { id: "explicit" };
    const active = { id: "active" };
    const recent = { id: "recent" };
    expect(chooseMarkdownSource(explicit, active, recent)).toBe(explicit);
    expect(chooseMarkdownSource(undefined, active, recent)).toBe(active);
  });
});

describe("locateUniqueTextSelection", () => {
  it("maps an exact Reading View DOM selection to source positions", () => {
    const result = locateUniqueTextSelection(
      "# 标题\n\n3个时间点，2个分组中，筛掉数量太少的细胞（n>500）\n\n结尾",
      "3个时间点，2个分组中，筛掉数量太少的细胞（n>500）",
    );

    expect(result).toEqual({
      from: { line: 2, ch: 0 },
      text: "3个时间点，2个分组中，筛掉数量太少的细胞（n>500）",
      to: { line: 2, ch: 28 },
    });
  });

  it("refuses ambiguous or absent rendered text", () => {
    expect(locateUniqueTextSelection("same\nsame", "same")).toBeUndefined();
    expect(locateUniqueTextSelection("source", "rendered")).toBeUndefined();
  });
});
