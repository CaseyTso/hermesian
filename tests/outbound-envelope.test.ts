import { describe, expect, it } from "vitest";

import {
  OBSIDIAN_IDENTITY_CONTEXT,
  OBSIDIAN_OUTPUT_RULES,
  buildEnvelopePrompt,
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
