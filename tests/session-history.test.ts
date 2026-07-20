import { describe, expect, it } from "vitest";

import {
  historyItemsFromUpdates,
  isReasoningEffort,
  normalizeSessionEntries,
  reasoningEffortLabel,
} from "../src/session-history";

describe("normalizeSessionEntries", () => {
  it("keeps valid ACP session metadata and ignores malformed rows", () => {
    expect(
      normalizeSessionEntries([
        { sessionId: "s1", cwd: "/vault", title: "A", updatedAt: "2026-07-15" },
        { sessionId: "", cwd: "/vault" },
        null,
      ]),
    ).toEqual([
      { cwd: "/vault", sessionId: "s1", title: "A", updatedAt: "2026-07-15" },
    ]);
  });
});

describe("historyItemsFromUpdates", () => {
  it("merges streamed text and keeps tool activity as separate items", () => {
    expect(
      historyItemsFromUpdates([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "read", status: "pending" },
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      ]),
    ).toEqual([
      { kind: "user", text: "Hi" },
      { kind: "assistant", text: "Hello" },
      { id: "t1", kind: "tool", status: "completed", title: "read" },
    ]);
  });
});

describe("reasoning effort", () => {
  it("accepts Hermes values and labels the provider default", () => {
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("invalid")).toBe(false);
    expect(reasoningEffortLabel("default")).toBe("Provider default");
  });
});