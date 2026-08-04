import { describe, expect, it } from "vitest";

import { normalizeTableSpacing } from "../src/markdown-table";

describe("normalizeTableSpacing", () => {
  it("inserts a blank line before a table that directly follows a non-empty line", () => {
    const source = ["**文件变更**", "| 文件 | 操作 |", "|---|---|"].join("\n");

    expect(normalizeTableSpacing(source)).toBe(
      ["**文件变更**", "", "| 文件 | 操作 |", "|---|---|"].join("\n"),
    );
  });

  it("leaves an existing blank line untouched and is idempotent", () => {
    const alreadySeparated = ["**文件变更**", "", "| 文件 | 操作 |", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(alreadySeparated)).toBe(alreadySeparated);

    const fixed = ["**文件变更**", "", "| 文件 | 操作 |", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(normalizeTableSpacing(fixed))).toBe(fixed);
  });

  it("does not modify table-like lines inside backtick fenced code", () => {
    const source = [
      "代码：",
      "```md",
      "**文件变更**",
      "| 文件 | 操作 |",
      "|---|---|",
      "```",
      "| 后文 | 表格 |",
      "|---|---|",
    ].join("\n");

    expect(normalizeTableSpacing(source)).toBe(
      [
        "代码：",
        "```md",
        "**文件变更**",
        "| 文件 | 操作 |",
        "|---|---|",
        "```",
        "",
        "| 后文 | 表格 |",
        "|---|---|",
      ].join("\n"),
    );
  });

  it("does not modify table-like lines inside tilde fenced code", () => {
    const source = [
      "~~~md",
      "| a | b |",
      "|---|---|",
      "~~~",
      "| c | d |",
      "|---|---|",
    ].join("\n");

    expect(normalizeTableSpacing(source)).toBe(
      [
        "~~~md",
        "| a | b |",
        "|---|---|",
        "~~~",
        "",
        "| c | d |",
        "|---|---|",
      ].join("\n"),
    );
  });

  it("does not touch pipe text whose following row is not a legal delimiter row", () => {
    const source = ["标题", "| 文件 | 操作 |", "| 修改 | 增加 |"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);

    const trailingText = ["标题", "foo | bar", "|---|---| 说明文字"].join("\n");
    expect(normalizeTableSpacing(trailingText)).toBe(trailingText);
  });

  it("recognizes alignment colons and optional leading/trailing pipes", () => {
    const aligned = ["标题", "| a | b |", "| :--- | ---: |"].join("\n");
    expect(normalizeTableSpacing(aligned)).toBe(
      ["标题", "", "| a | b |", "| :--- | ---: |"].join("\n"),
    );

    const noOuterPipes = ["标题", "a | b", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(noOuterPipes)).toBe(
      ["标题", "", "a | b", "|---|---|"].join("\n"),
    );

    const centered = ["标题", "| a | b |", "|:---:|---|"].join("\n");
    expect(normalizeTableSpacing(centered)).toBe(
      ["标题", "", "| a | b |", "|:---:|---|"].join("\n"),
    );
  });

  it("preserves body text and inline code while fixing the following table", () => {
    const source = ["正文段落", "`inline | code`", "| a | b |", "|---|---|"].join("\n");

    expect(normalizeTableSpacing(source)).toBe(
      ["正文段落", "`inline | code`", "", "| a | b |", "|---|---|"].join("\n"),
    );
  });

  it("leaves a table at the start of the document unchanged", () => {
    const source = ["| a | b |", "|---|---|", "正文"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("separates two adjacent tables with exactly one blank line", () => {
    const source = ["| a | b |", "|---|---|", "| c | d |", "|---|---|"].join("\n");

    expect(normalizeTableSpacing(source)).toBe(
      ["| a | b |", "|---|---|", "", "| c | d |", "|---|---|"].join("\n"),
    );
  });

  it("treats a whitespace-only previous line as blank and inserts nothing", () => {
    const source = ["标题", "   ", "| a | b |", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("does not modify 4-space indented code that looks like a table", () => {
    const source = ["示例：", "    | a | b |", "    |---|---|"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("does not close a backtick fence on a line with trailing info text (still-code)", () => {
    const source = [
      "```md",
      "**文件变更**",
      "| 文件 | 操作 |",
      "|---|---|",
      "```still-code",
      "| 仍在代码块内 | 表格 |",
      "|---|---|",
    ].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("does not close a tilde fence on a line with trailing info text", () => {
    const source = [
      "~~~md",
      "| a | b |",
      "|---|---|",
      "~~~still-code",
      "| c | d |",
      "|---|---|",
    ].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("does not treat a setext heading containing an escaped pipe as a table header", () => {
    const source = ["正文", "一级标题 \\| 序号", "---"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("does not treat a line whose only pipes are inside inline code as a header row", () => {
    const source = ["正文", "使用 `|` 字符", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("does not treat a header/delimiter pair with mismatched column counts as a table", () => {
    const source = ["标题", "| a | b | c |", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(source)).toBe(source);
  });

  it("counts cells on escaped pipes and inline code pipes like GFM", () => {
    const escapedPipeCell = ["正文", "标题 \\| A | B", "| --- | --- |"].join("\n");
    expect(normalizeTableSpacing(escapedPipeCell)).toBe(
      ["正文", "", "标题 \\| A | B", "| --- | --- |"].join("\n"),
    );

    const inlineCodeCell = ["`a|b` 说明", "| 1 | 2 |", "|---|---|"].join("\n");
    expect(normalizeTableSpacing(inlineCodeCell)).toBe(
      ["`a|b` 说明", "", "| 1 | 2 |", "|---|---|"].join("\n"),
    );
  });
});
