import type { HermesSkillOption, HermesSlashCommand } from "./types";

export interface SlashMenuItem {
  category?: string;
  description: string;
  inputHint?: string;
  kind: "command" | "skill-loader" | "skill";
  name: string;
}

/** Atomic slash prefix chosen from the menu (not free-typed plain text). */
export type ComposerSlashToken =
  | { kind: "skill"; name: string }
  | { kind: "command"; name: string };

/** Single source of truth for composer slash display vs send/persist value. */
export interface ComposerSlashDraft {
  task: string;
  token: ComposerSlashToken | null;
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

/** Visible label shown in the composer token (e.g. `/leader`, `/model`). */
export function visibleSlashTokenLabel(token: ComposerSlashToken): string {
  return `/${token.name}`;
}

/** Build token state from a menu selection. skill-loader stays plain insertion. */
export function composerSlashTokenFromMenuItem(
  item: SlashMenuItem,
): ComposerSlashToken | null {
  if (item.kind === "skill") {
    return { kind: "skill", name: item.name };
  }
  if (item.kind === "command") {
    return { kind: "command", name: item.name };
  }
  return null;
}

/**
 * Serialize visible token + task into the canonical draft/send string.
 * Skills always use `/skill <name> …` so outbound loading stays unchanged.
 */
export function serializeComposerSlashDraft(draft: ComposerSlashDraft): string {
  const task = draft.task;
  if (!draft.token) {
    return task;
  }
  if (draft.token.kind === "skill") {
    return task ? `/skill ${draft.token.name} ${task}` : `/skill ${draft.token.name} `;
  }
  return task ? `/${draft.token.name} ${task}` : `/${draft.token.name} `;
}

/** Name pattern shared by the slash/skill send protocol and token validation. */
export const SLASH_TOKEN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Parse a persisted/canonical draft back into token + task.
 * Never infers a token from text alone — without explicit metadata everything
 * stays plain text (including `/skill <name> task`).
 */
export function parseComposerSlashDraft(raw: string): ComposerSlashDraft {
  return restoreComposerSlashDraft(raw, null);
}

/**
 * Single restore decision: raw draft + explicit token metadata → {token, task}.
 * - Without metadata: never infer a token; return the raw draft verbatim.
 * - With metadata: the token must be valid (kind + name pattern) AND the draft
 *   must equal the canonical prefix or start with "prefix + single space".
 *   Any mismatch keeps the raw draft verbatim as plain text (no token).
 */
export function restoreComposerSlashDraft(
  raw: string,
  explicitToken?: { kind: "skill" | "command"; name: string } | null,
): ComposerSlashDraft {
  if (!explicitToken) {
    return { token: null, task: raw };
  }
  if (explicitToken.kind !== "skill" && explicitToken.kind !== "command") {
    return { token: null, task: raw };
  }
  if (!SLASH_TOKEN_NAME_PATTERN.test(explicitToken.name)) {
    return { token: null, task: raw };
  }
  const prefix =
    explicitToken.kind === "skill"
      ? `/skill ${explicitToken.name}`
      : `/${explicitToken.name}`;
  if (raw === prefix) {
    return { token: explicitToken, task: "" };
  }
  if (raw.startsWith(`${prefix} `)) {
    return { token: explicitToken, task: raw.slice(prefix.length + 1) };
  }
  // Metadata valid but draft does not match the canonical prefix — keep the
  // draft verbatim as plain text. Never split or rewrite the raw text.
  return { token: null, task: raw };
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
