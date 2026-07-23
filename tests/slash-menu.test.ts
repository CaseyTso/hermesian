import { describe, expect, it } from "vitest";

import {
  buildSlashOutboundPrompt,
  buildSlashMenuItems,
  slashMenuInsertion,
} from "../src/slash-menu";
import type { HermesSkillOption, HermesSlashCommand } from "../src/types";

const commands: HermesSlashCommand[] = [
  { name: "help", description: "List available commands" },
  {
    name: "model",
    description: "Switch models",
    inputHint: "model name to switch to",
  },
];

const skills: HermesSkillOption[] = [
  { name: "plan", category: "", description: "Plan mode" },
  {
    name: "research-lookup",
    category: "research",
    description: "Look up research",
  },
];

describe("buildSlashMenuItems", () => {
  it("shows ACP commands, a skill loader, and enabled skills for a bare slash", () => {
    const items = buildSlashMenuItems("/", commands, skills);

    expect(items.map((item) => `${item.kind}:${item.name}`)).toEqual([
      "command:help",
      "command:model",
      "skill-loader:skill",
      "skill:plan",
      "skill:research-lookup",
    ]);
  });

  it("filters direct skill aliases and inserts the explicit skill command", () => {
    const items = buildSlashMenuItems("/pla", commands, skills);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "skill", name: "plan" });
    expect(slashMenuInsertion(items[0]!)).toBe("/skill plan ");
  });

  it("shows only matching skills after /skill", () => {
    const items = buildSlashMenuItems("/skill RES", commands, skills);

    expect(items.map((item) => item.name)).toEqual(["research-lookup"]);
  });

  it("closes after a normal command argument or a selected skill", () => {
    expect(buildSlashMenuItems("/model grok", commands, skills)).toEqual([]);
    expect(buildSlashMenuItems("/skill plan ", commands, skills)).toEqual([]);
  });
});

describe("buildSlashOutboundPrompt", () => {
  it("forwards native ACP commands unchanged", () => {
    expect(buildSlashOutboundPrompt("/model grok")).toBe("/model grok");
  });

  it("turns a skill selection into an explicit load instruction", () => {
    expect(buildSlashOutboundPrompt("/skill plan Draft a migration plan")).toBe(
      'Load and follow the installed Hermes skill named "plan" before handling this request.\n\nUser request:\nDraft a migration plan',
    );
  });
});
