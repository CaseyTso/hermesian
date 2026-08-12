import { stripEnvelopeFromPrompt } from "./outbound-envelope";
import type { HermesHistoryEntry, HermesHistoryItem, ReasoningEffort } from "./types";

export const REASONING_EFFORTS: ReasoningEffort[] = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return effort === "default" ? "Provider default" : effort;
}

export function normalizeSessionEntries(value: unknown): HermesHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
    if (!sessionId || !cwd) {
      return [];
    }
    const title = typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : undefined;
    const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : undefined;
    return [{ cwd, sessionId, title, updatedAt }];
  });
}

export function historyItemsFromUpdates(updates: unknown[]): HermesHistoryItem[] {
  const items: HermesHistoryItem[] = [];
  const tools = new Map<string, Extract<HermesHistoryItem, { kind: "tool" }>>();
  for (const raw of updates) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const update = raw as Record<string, unknown>;
    const kind = update.sessionUpdate;
    if (
      (kind === "user_message_chunk" ||
        kind === "agent_message_chunk" ||
        kind === "agent_thought_chunk") &&
      update.content &&
      typeof update.content === "object"
    ) {
      const content = update.content as Record<string, unknown>;
      if (content.type !== "text" || typeof content.text !== "string") {
        continue;
      }
      const itemKind =
        kind === "user_message_chunk"
          ? "user"
          : kind === "agent_message_chunk"
            ? "assistant"
            : "thought";
      // Resume/load stores the full outbound envelope on user messages; strip
      // only exact buildEnvelopePrompt products so the UI shows bare user text.
      // Assistant/thought chunks are never enveloped and must stay intact.
      const text =
        itemKind === "user" ? stripEnvelopeFromPrompt(content.text) : content.text;
      if (itemKind === "user" && !text) {
        // Empty after strip (defensive): do not render an empty user bubble.
        continue;
      }
      const previous = items.at(-1);
      if (previous?.kind === itemKind) {
        previous.text += text;
      } else {
        items.push({ kind: itemKind, text });
      }
      continue;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
      if (!id) {
        continue;
      }
      const existing = tools.get(id);
      const item = existing ?? {
        id,
        kind: "tool" as const,
        title: "Hermes tool",
      };
      if (typeof update.title === "string" && update.title.trim()) {
        item.title = update.title;
      }
      if (typeof update.status === "string" && update.status.trim()) {
        item.status = update.status;
      }
      if (!existing) {
        tools.set(id, item);
        items.push(item);
      }
    }
  }
  return items.filter((item) => item.kind !== "thought" || item.text.trim());
}