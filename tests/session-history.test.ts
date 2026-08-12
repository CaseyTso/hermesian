import { describe, expect, it } from "vitest";

import {
  buildEnvelopePrompt,
  OBSIDIAN_IDENTITY_CONTEXT,
  OBSIDIAN_OUTPUT_RULES,
} from "../src/outbound-envelope";
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

  it("strips the outbound envelope from resumed user history before display", () => {
    const userText = "总结这篇笔记";
    const enveloped = buildEnvelopePrompt(userText, false);

    expect(
      historyItemsFromUpdates([
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: enveloped },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "好的，这是摘要。" },
        },
      ]),
    ).toEqual([
      { kind: "user", text: userText },
      { kind: "assistant", text: "好的，这是摘要。" },
    ]);
  });

  it("keeps native slash history, assistant text, and non-matching user lookalikes intact", () => {
    const slash = "/new";
    const lookalike = `${OBSIDIAN_IDENTITY_CONTEXT.slice(0, 20)} not a real block`;
    const differentContent = `<hermesian_identity>
用户自写
</hermesian_identity>\n\n仍是我的输入\n\n${OBSIDIAN_OUTPUT_RULES}`;

    expect(
      historyItemsFromUpdates([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: slash } },
        {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: buildEnvelopePrompt("assistant never gets this", false),
          },
        },
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: lookalike },
        },
        // Separate turns with an agent chunk so consecutive-user merge is not in play.
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ack" },
        },
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: differentContent },
        },
      ]),
    ).toEqual([
      { kind: "user", text: slash },
      {
        kind: "assistant",
        text: buildEnvelopePrompt("assistant never gets this", false),
      },
      { kind: "user", text: lookalike },
      { kind: "assistant", text: "ack" },
      { kind: "user", text: differentContent },
    ]);
  });

  it("drops empty user bubbles that only contained the envelope (defensive)", () => {
    expect(
      historyItemsFromUpdates([
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: buildEnvelopePrompt("", false) },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "still show assistant" },
        },
      ]),
    ).toEqual([{ kind: "assistant", text: "still show assistant" }]);
  });
});

describe("reasoning effort", () => {
  it("accepts Hermes values and labels the provider default", () => {
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("invalid")).toBe(false);
    expect(reasoningEffortLabel("default")).toBe("Provider default");
  });
});