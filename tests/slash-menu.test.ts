import { describe, expect, it } from "vitest";

import {
  buildSlashOutboundPrompt,
  buildSlashMenuItems,
  composerSlashTokenFromMenuItem,
  parseComposerSlashDraft,
  restoreComposerSlashDraft,
  serializeComposerSlashDraft,
  slashMenuInsertion,
  visibleSlashTokenLabel,
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
  { name: "leader", category: "software-development", description: "Write goals" },
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
      "skill:leader",
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

describe("composer slash draft model", () => {
  it("exposes skill visible label without /skill while serializing the canonical value", () => {
    const item = buildSlashMenuItems("/lea", commands, skills)[0]!;
    expect(item).toMatchObject({ kind: "skill", name: "leader" });

    const token = composerSlashTokenFromMenuItem(item);
    expect(token).toEqual({ kind: "skill", name: "leader" });
    expect(visibleSlashTokenLabel(token!)).toBe("/leader");

    const draft = { token, task: "写任务书" };
    expect(serializeComposerSlashDraft(draft)).toBe("/skill leader 写任务书");
    expect(buildSlashOutboundPrompt(serializeComposerSlashDraft(draft))).toBe(
      'Load and follow the installed Hermes skill named "leader" before handling this request.\n\nUser request:\n写任务书',
    );
  });

  it("serializes native commands as /name task with a blue-token shape", () => {
    const item = buildSlashMenuItems("/mod", commands, skills)[0]!;
    expect(item).toMatchObject({ kind: "command", name: "model" });
    const token = composerSlashTokenFromMenuItem(item);
    expect(token).toEqual({ kind: "command", name: "model" });
    expect(visibleSlashTokenLabel(token!)).toBe("/model");
    expect(serializeComposerSlashDraft({ token, task: "grok" })).toBe(
      "/model grok",
    );
  });

  it("does not treat free-typed mid-text slash as a token", () => {
    expect(parseComposerSlashDraft("see /leader later")).toEqual({
      token: null,
      task: "see /leader later",
    });
    expect(parseComposerSlashDraft("hello")).toEqual({
      token: null,
      task: "hello",
    });
    // Incomplete slash menu typing stays plain until selection inserts trailing space
    expect(parseComposerSlashDraft("/lea")).toEqual({
      token: null,
      task: "/lea",
    });
  });

  it("round-trips draft restore for skill tokens with explicit metadata", () => {
    const skillCanonical = serializeComposerSlashDraft({
      token: { kind: "skill", name: "leader" },
      task: "写任务书",
    });
    expect(
      restoreComposerSlashDraft(skillCanonical, { kind: "skill", name: "leader" }),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      task: "写任务书",
    });

    // Empty task still keeps the skill token (menu insertion form)
    expect(
      restoreComposerSlashDraft("/skill leader ", { kind: "skill", name: "leader" }),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      task: "",
    });
  });

  it("keeps skill-loader as plain insertion without a capsule token", () => {
    const loader = buildSlashMenuItems("/", commands, skills).find(
      (item) => item.kind === "skill-loader",
    )!;
    expect(composerSlashTokenFromMenuItem(loader)).toBeNull();
    expect(slashMenuInsertion(loader)).toBe("/skill ");
  });

  it("does not infer a command token from free-typed /random ordinary text", () => {
    // Without explicit token metadata, arbitrary /name task text must stay
    // as plain text — only menu-selected commands get a token.
    expect(parseComposerSlashDraft("/random ordinary text")).toEqual({
      token: null,
      task: "/random ordinary text",
    });
  });

  it("does not infer a command token from known command name without menu selection", () => {
    // Even a known command name like /model typed manually (not via menu)
    // must not get a token — only explicit metadata triggers it.
    expect(parseComposerSlashDraft("/model grok")).toEqual({
      token: null,
      task: "/model grok",
    });
  });

  it("does not infer a skill token from /skill without metadata", () => {
    // No exception for /skill — without explicit metadata everything is plain text.
    expect(parseComposerSlashDraft("/skill leader 写任务书")).toEqual({
      token: null,
      task: "/skill leader 写任务书",
    });
  });
});

describe("restoreComposerSlashDraft", () => {
  it("never infers a token without metadata, including /skill", () => {
    expect(restoreComposerSlashDraft("/skill leader task", null)).toEqual({
      token: null,
      task: "/skill leader task",
    });
    expect(restoreComposerSlashDraft("/model grok")).toEqual({
      token: null,
      task: "/model grok",
    });
    expect(restoreComposerSlashDraft("/random text")).toEqual({
      token: null,
      task: "/random text",
    });
  });

  it("restores a valid command token when draft matches metadata", () => {
    expect(
      restoreComposerSlashDraft("/model grok", { kind: "command", name: "model" }),
    ).toEqual({
      token: { kind: "command", name: "model" },
      task: "grok",
    });
  });

  it("restores a valid skill token when draft matches metadata", () => {
    expect(
      restoreComposerSlashDraft("/skill leader 写任务书", {
        kind: "skill",
        name: "leader",
      }),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      task: "写任务书",
    });
  });

  it("allows empty task for canonical prefix or prefix with trailing space", () => {
    expect(
      restoreComposerSlashDraft("/skill leader", { kind: "skill", name: "leader" }),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      task: "",
    });
    expect(
      restoreComposerSlashDraft("/skill leader ", { kind: "skill", name: "leader" }),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      task: "",
    });
    expect(
      restoreComposerSlashDraft("/model ", { kind: "command", name: "model" }),
    ).toEqual({
      token: { kind: "command", name: "model" },
      task: "",
    });
  });

  it("drops token when draft does not match the canonical prefix", () => {
    // Different command name
    expect(
      restoreComposerSlashDraft("/other task", { kind: "command", name: "model" }),
    ).toEqual({
      token: null,
      task: "/other task",
    });
    // Case mismatch
    expect(
      restoreComposerSlashDraft("/Skill Leader 写任务书", {
        kind: "skill",
        name: "leader",
      }),
    ).toEqual({
      token: null,
      task: "/Skill Leader 写任务书",
    });
    // No separator space
    expect(
      restoreComposerSlashDraft("/modelgrok", { kind: "command", name: "model" }),
    ).toEqual({
      token: null,
      task: "/modelgrok",
    });
    // Name does not match metadata
    expect(
      restoreComposerSlashDraft("/skill leaderx task", {
        kind: "skill",
        name: "leader",
      }),
    ).toEqual({
      token: null,
      task: "/skill leaderx task",
    });
  });

  it("preserves multi-line tasks verbatim", () => {
    const raw = "/skill leader 第一行\n第二行\n第三行";
    expect(
      restoreComposerSlashDraft(raw, { kind: "skill", name: "leader" }),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      task: "第一行\n第二行\n第三行",
    });
  });

  it("rejects invalid token metadata names", () => {
    const badNames = ["bad name", "../leader", "/leader", "", "   ", "lead:er"];
    for (const name of badNames) {
      expect(
        restoreComposerSlashDraft(`/skill ${name} task`, {
          kind: "skill",
          name,
        }),
      ).toEqual({
        token: null,
        task: `/skill ${name} task`,
      });
    }
  });

  it("rejects unknown token kind", () => {
    expect(
      restoreComposerSlashDraft("/skill leader task", {
        kind: "invalid" as "skill",
        name: "leader",
      }),
    ).toEqual({
      token: null,
      task: "/skill leader task",
    });
  });
});
