import { describe, expect, it, vi } from "vitest";

import { HermesAcpClient } from "../src/acp-client";
import {
  HERMESIAN_REASONING_EFFORT_CONFIG_ID,
  HERMESIAN_REASONING_EFFORT_VERSION,
} from "../src/hermes-acp-adapter";
import type { ReasoningEffort } from "../src/types";

function createClient(options: {
  desiredReasoningEffort?: () => ReasoningEffort;
  requestHandler?: (...args: unknown[]) => Promise<unknown>;
  resumedSessionId?: string;
}) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = new HermesAcpClient({
    desiredReasoningEffort: options.desiredReasoningEffort ?? (() => "default"),
    onEvent: () => undefined,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    pluginVersion: "test",
    settings: () => ({
      acceptHooks: true,
      autoApproveVaultEdits: true,
      debugLogging: false,
      hermesExecutable: "hermes",
      hiddenModelSwitchIds: [],
      profile: "default",
      reasoningEffort: "default",
    }),
    vaultPath: "/tmp/hermesian-test-vault",
  });

  const request = vi.fn(async (method: string, params: any, ...rest: unknown[]) => {
    calls.push({ method, params });
    if (options.requestHandler) {
      return options.requestHandler(method, params, ...rest);
    }
    if (method === "session/set_config_option") {
      return {
        configOptions: [],
        _meta: {
          applied: true,
          config_id: params.configId,
          effort: params.value,
          hermesian_version: HERMESIAN_REASONING_EFFORT_VERSION,
        },
      };
    }
    if (method === "session/prompt") {
      return { stopReason: "end_turn" };
    }
    return {};
  });

  Reflect.set(client, "connectPromise", Promise.resolve());
  Reflect.set(client, "connection", {
    close: vi.fn(),
    signal: { aborted: false },
  });
  Reflect.set(client, "context", { request });
  Reflect.set(client, "resumedSessionId", options.resumedSessionId ?? "test-session");
  Reflect.set(client, "intentionalShutdown", false);

  return { client, calls, request };
}

describe("HermesAcpClient reasoning effort transport", () => {
  it("snapshots and applies reasoning effort immediately before normal prompt", async () => {
    let currentEffort: ReasoningEffort = "high";
    const { client, calls } = createClient({
      desiredReasoningEffort: () => currentEffort,
    });

    await client.sendPrompt("test prompt 1");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: "session/set_config_option",
      params: {
        configId: HERMESIAN_REASONING_EFFORT_CONFIG_ID,
        sessionId: "test-session",
        value: "high",
      },
    });
    expect(calls[1].method).toBe("session/prompt");
    expect(client.appliedReasoningEffort).toBe("high");

    // Change effort for next prompt
    currentEffort = "low";
    await client.sendPrompt("test prompt 2");

    expect(calls).toHaveLength(4);
    expect(calls[2]).toEqual({
      method: "session/set_config_option",
      params: {
        configId: HERMESIAN_REASONING_EFFORT_CONFIG_ID,
        sessionId: "test-session",
        value: "low",
      },
    });
    expect(client.appliedReasoningEffort).toBe("low");
  });

  it("allows explicit prompt-level reasoning effort override", async () => {
    const { client, calls } = createClient({
      desiredReasoningEffort: () => "medium",
    });

    await client.sendPrompt("test prompt", { reasoningEffort: "xhigh" });

    expect(calls[0]).toEqual({
      method: "session/set_config_option",
      params: {
        configId: HERMESIAN_REASONING_EFFORT_CONFIG_ID,
        sessionId: "test-session",
        value: "xhigh",
      },
    });
    expect(client.appliedReasoningEffort).toBe("xhigh");
  });

  it("rejects sendPrompt when adapter response lacks versioned acknowledgment", async () => {
    const { client } = createClient({
      requestHandler: async (method) => {
        if (method === "session/set_config_option") {
          // Unadapted upstream Hermes returns empty configOptions with no _meta
          return { configOptions: [] };
        }
        return { stopReason: "end_turn" };
      },
    });

    await expect(client.sendPrompt("test prompt")).rejects.toThrow(
      /Hermes ACP adapter did not acknowledge reasoning effort/,
    );
  });

  it("rejects sendPrompt when effort value is invalid", async () => {
    const { client } = createClient({});

    await expect(
      client.sendPrompt("test prompt", { reasoningEffort: "invalid_level" as any }),
    ).rejects.toThrow(/Invalid reasoning effort/);
  });

  it("never applies reasoning effort during steer", async () => {
    const { client, calls } = createClient({
      desiredReasoningEffort: () => "high",
    });

    // Put client into active turn state
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);

    await client.steerActiveTurn("steer correction");
    expect(calls.some((c) => c.method === "session/prompt")).toBe(true);

    // Steer should send session/prompt directly without calling set_config_option
    expect(calls.some((c) => c.method === "session/set_config_option")).toBe(false);
  });

  it("applies before the fresh session prompt, not only resumed sessions", async () => {
    const { client, calls } = createClient({});
    const prompt = vi.fn(() => { expect(calls[0].method).toBe("session/set_config_option"); });
    Reflect.set(client, "resumedSessionId", undefined);
    Reflect.set(client, "activeSession", { sessionId: "fresh", prompt, nextUpdate: async () => ({ kind: "stop", stopReason: "end_turn" }) });
    await client.sendPrompt("fresh prompt");
    expect(prompt).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "disconnect"])("never dispatches a late prompt after %s during config acknowledgment", async (action) => {
    let resolveAck!: (value: unknown) => void;
    const gate = new Promise((resolve) => { resolveAck = resolve; });
    const { client, calls } = createClient({ requestHandler: async () => gate });
    const sending = client.sendPrompt("must not send");
    const rejected = expect(sending).rejects.toThrow(/cancelled|stale/);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await (action === "cancel" ? client.cancel() : client.disconnect());
    resolveAck({ _meta: { applied: true, config_id: HERMESIAN_REASONING_EFFORT_CONFIG_ID,
      effort: "default", hermesian_version: 1 } });
    await rejected;
    expect(calls.some((c) => c.method === "session/prompt")).toBe(false);
    expect(client.isBusy).toBe(false);
    if (action === "disconnect") expect(client.appliedReasoningEffort).toBeUndefined();
  });

  it("bounds an unresponsive config acknowledgment and releases the prompt slot", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = createClient({ requestHandler: () => new Promise(() => {}) });
      const failure = expect(client.sendPrompt("waiting")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_001);
      await failure;
      expect(client.isBusy).toBe(false);
      expect(calls.some((c) => c.method === "session/prompt")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("rejects prompt when session is missing", async () => {
    const { client } = createClient({ resumedSessionId: undefined });
    Reflect.set(client, "resumedSessionId", undefined);
    Reflect.set(client, "activeSession", undefined);

    await expect(client.sendPrompt("test prompt")).rejects.toThrow(
      "Hermes ACP session is unavailable",
    );
  });
});
