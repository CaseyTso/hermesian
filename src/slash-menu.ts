import type { HermesSkillOption, HermesSlashCommand } from "./types";

export interface SlashMenuItem {
  category?: string;
  description: string;
  inputHint?: string;
  kind: "command" | "skill-loader" | "skill";
  name: string;
}

function matches(item: SlashMenuItem, query: string): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLocaleLowerCase();
  return [item.name, item.description, item.category ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function commandItem(command: HermesSlashCommand): SlashMenuItem {
  return {
    description: command.description,
    inputHint: command.inputHint,
    kind: "command",
    name: command.name,
  };
}

function skillItem(skill: HermesSkillOption): SlashMenuItem {
  return {
    category: skill.category,
    description: skill.description,
    kind: "skill",
    name: skill.name,
  };
}

export function buildSlashMenuItems(
  value: string,
  commands: HermesSlashCommand[],
  skills: HermesSkillOption[],
): SlashMenuItem[] {
  const skillQuery = /^\/skill(?:\s+(\S*))?$/i.exec(value);
  if (skillQuery) {
    const query = skillQuery[1] ?? "";
    return skills.map(skillItem).filter((item) => matches(item, query));
  }

  const rootQuery = /^\/([^\s/]*)$/.exec(value);
  if (!rootQuery) {
    return [];
  }
  const query = rootQuery[1] ?? "";
  const items = commands.map(commandItem);
  if (skills.length > 0) {
    items.push({
      description: "Load an installed Hermes skill",
      inputHint: "skill name",
      kind: "skill-loader",
      name: "skill",
    });
    items.push(...skills.map(skillItem));
  }
  return items.filter((item) => matches(item, query));
}

export function slashMenuInsertion(item: SlashMenuItem): string {
  if (item.kind === "skill") {
    return `/skill ${item.name} `;
  }
  return `/${item.name} `;
}

export function buildSlashOutboundPrompt(request: string): string {
  const skillInvocation = /^\/skill\s+([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]+))?$/i.exec(
    request,
  );
  if (!skillInvocation) {
    return request;
  }

  const skillName = skillInvocation[1]!;
  const task = skillInvocation[2]?.trim();
  const instruction = `Load and follow the installed Hermes skill named "${skillName}" before handling this request.`;
  return task
    ? `${instruction}\n\nUser request:\n${task}`
    : `${instruction}\n\nAfter loading the skill, briefly confirm that it is ready and ask what task to perform.`;
}
