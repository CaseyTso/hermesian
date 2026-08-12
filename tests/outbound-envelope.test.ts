import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  OBSIDIAN_IDENTITY_CONTEXT,
  OBSIDIAN_OUTPUT_RULES,
  buildEnvelopePrompt,
  stripEnvelopeFromPrompt,
  stripUserPromptForDisplay,
} from "../src/outbound-envelope";

describe("buildEnvelopePrompt", () => {
  it("prepends the Obsidian sidebar identity and appends the output rules to ordinary requests", () => {
    const prompt = buildEnvelopePrompt("总结这篇笔记", false);

    expect(prompt.startsWith(OBSIDIAN_IDENTITY_CONTEXT)).toBe(true);
    expect(prompt.endsWith(OBSIDIAN_OUTPUT_RULES)).toBe(true);
    expect(prompt).toContain("你在 Obsidian 右侧边栏运行，可加载 obsidian skill 操作 vault 笔记。");
    expect(prompt).toContain("总结这篇笔记");
    expect(prompt).toContain("<hermesian_identity>");
    expect(prompt).toContain("<hermesian_output_rules>");
  });

  it("keeps the user request intact between the identity block and the output rules", () => {
    const prompt = buildEnvelopePrompt("请改写这段", false);

    const identityEnd = prompt.indexOf("</hermesian_identity>");
    const rulesStart = prompt.indexOf("<hermesian_output_rules>");
    expect(identityEnd).toBeGreaterThan(0);
    expect(rulesStart).toBeGreaterThan(identityEnd);
    expect(prompt.slice(identityEnd, rulesStart)).toContain("请改写这段");
  });

  it("passes native control commands through unchanged, without identity or rules", () => {
    for (const command of ["/new", "/model grok", "/skill plan 写任务书"]) {
      expect(buildEnvelopePrompt(command, true)).toBe(command);
    }
  });

  it("never leaks the identity or rules into a native slash command", () => {
    const prompt = buildEnvelopePrompt("/new", true);
    expect(prompt).not.toContain("<hermesian_identity>");
    expect(prompt).not.toContain("<hermesian_output_rules>");
  });
});

describe("stripEnvelopeFromPrompt", () => {
  it("round-trips ordinary requests built by buildEnvelopePrompt back to the bare user text", () => {
    const userText = "总结这篇笔记";
    const enveloped = buildEnvelopePrompt(userText, false);

    expect(enveloped).toContain("<hermesian_identity>");
    expect(enveloped).toContain("<hermesian_output_rules>");
    expect(stripEnvelopeFromPrompt(enveloped)).toBe(userText);
  });

  it("preserves multiline user prompts and surrounding whitespace that belong to the prompt", () => {
    const userText = "第一行\n\n第二行  ";
    expect(stripEnvelopeFromPrompt(buildEnvelopePrompt(userText, false))).toBe(userText);
  });

  it("leaves native slash commands that never received an envelope untouched", () => {
    for (const command of ["/new", "/model grok", "/skill plan 写任务书"]) {
      expect(stripEnvelopeFromPrompt(command)).toBe(command);
      expect(stripEnvelopeFromPrompt(buildEnvelopePrompt(command, true))).toBe(command);
    }
  });

  it("does not strip user text that only mentions the tags without the exact injected blocks", () => {
    const lookalike =
      "<hermesian_identity>\n用户自己写的身份\n</hermesian_identity>\n\n真实提问\n\n<hermesian_output_rules>\n用户自己写的规则\n</hermesian_output_rules>";
    expect(stripEnvelopeFromPrompt(lookalike)).toBe(lookalike);
  });

  it("does not strip when open/close tags match but injected content differs from the constants", () => {
    const differentIdentity = `<hermesian_identity>
其他身份文案
</hermesian_identity>\n\n真实提问\n\n${OBSIDIAN_OUTPUT_RULES}`;
    expect(stripEnvelopeFromPrompt(differentIdentity)).toBe(differentIdentity);

    const differentRules = `${OBSIDIAN_IDENTITY_CONTEXT}\n\n真实提问\n\n<hermesian_output_rules>
其他规则
</hermesian_output_rules>`;
    expect(stripEnvelopeFromPrompt(differentRules)).toBe(differentRules);
  });

  it("does not strip when only one envelope block is present", () => {
    const identityOnly = `${OBSIDIAN_IDENTITY_CONTEXT}\n\n真实提问`;
    const rulesOnly = `真实提问\n\n${OBSIDIAN_OUTPUT_RULES}`;
    expect(stripEnvelopeFromPrompt(identityOnly)).toBe(identityOnly);
    expect(stripEnvelopeFromPrompt(rulesOnly)).toBe(rulesOnly);
  });

  it("returns an empty string when the envelope wrapped an empty prompt (defensive)", () => {
    expect(stripEnvelopeFromPrompt(buildEnvelopePrompt("", false))).toBe("");
  });

  it("leaves plain user text and assistant-like freeform content unchanged", () => {
    expect(stripEnvelopeFromPrompt("hello world")).toBe("hello world");
    expect(stripEnvelopeFromPrompt("这里没有信封")).toBe("这里没有信封");
  });

  it("is idempotent: stripping an already-stripped result changes nothing", () => {
    const userText = "总结这篇笔记";
    const once = stripEnvelopeFromPrompt(buildEnvelopePrompt(userText, false));
    expect(once).toBe(userText);
    expect(stripEnvelopeFromPrompt(once)).toBe(userText);
  });
});

describe("stripUserPromptForDisplay", () => {
  it("round-trips the full envelope back to the bare user text", () => {
    const userText = "总结这篇笔记";
    expect(stripUserPromptForDisplay(buildEnvelopePrompt(userText, false))).toBe(userText);
  });

  it("unwraps a tail-only persisted message (context wrapper + output rules)", () => {
    const wrapped = `你正在通过 Hermesian 协助用户使用 Obsidian。

<obsidian_context>
active_note: Research/note.md
document_included: false
</obsidian_context>

用户请求：看看这篇笔记

${OBSIDIAN_OUTPUT_RULES}`;
    expect(stripUserPromptForDisplay(wrapped)).toBe("看看这篇笔记");
  });

  it("unwraps a head-only persisted message (identity + context wrapper)", () => {
    const wrapped = `${OBSIDIAN_IDENTITY_CONTEXT}

你正在通过 Hermesian 协助用户使用 Obsidian。

<obsidian_context>
active_note: Research/note.md
document_included: false
</obsidian_context>

用户请求：看看这篇笔记`;
    expect(stripUserPromptForDisplay(wrapped)).toBe("看看这篇笔记");
  });

  it("leaves plain text, slash commands and steer corrections untouched", () => {
    expect(stripUserPromptForDisplay("hello world")).toBe("hello world");
    expect(stripUserPromptForDisplay("/new")).toBe("/new");
    expect(stripUserPromptForDisplay("看这篇笔记的minerU原文")).toBe("看这篇笔记的minerU原文");
  });

  it("keeps a user-typed lookalike wrapper intact (not a build product)", () => {
    const lookalike = "你正在协助用户编辑 Obsidian Markdown 知识库。\n\n自己写的内容，没有用户请求标记";
    expect(stripUserPromptForDisplay(lookalike)).toBe(lookalike);
  });

  it("strips a persisted tail-only history text shape (envelope-less + rules tail fixture)", () => {
    // Fixtures carry a trailing newline from the filesystem; persisted DB
    // text does not, so normalize before asserting.
    const real = readFileSync(
      resolve(process.cwd(), "tests/fixtures/persisted-selection-prompt.txt"),
      "utf8",
    ).replace(/\n$/, "");
    const stripped = stripUserPromptForDisplay(real);
    expect(stripped).not.toContain("你正在协助用户编辑");
    expect(stripped).not.toContain("<document>");
    expect(stripped).not.toContain("<hermesian_output_rules>");
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped).not.toContain("用户请求：");
  });

  it("strips a persisted full-envelope history text shape (fixture)", () => {
    const real = readFileSync(
      resolve(process.cwd(), "tests/fixtures/persisted-figure2-message.txt"),
      "utf8",
    ).replace(/\n$/, "");
    const stripped = stripUserPromptForDisplay(real);
    expect(stripped).not.toContain("<hermesian_identity>");
    expect(stripped).not.toContain("<hermesian_output_rules>");
    expect(stripped).toContain("Figure2");
  });
});
