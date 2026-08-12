import { describe, expect, it } from "vitest";

import {
  OBSIDIAN_IDENTITY_CONTEXT,
  OBSIDIAN_OUTPUT_RULES,
  buildEnvelopePrompt,
  stripEnvelopeFromPrompt,
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
});
