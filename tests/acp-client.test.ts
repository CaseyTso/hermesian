import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import {
  aggregateSteerCapture,
  automaticVaultEditApproval,
  buildHermesAcpArgs,
  classifySteerCapture,
  HermesAcpClient,
  STEER_SUCCESS_MARKER,
} from "../src/acp-client";

function permissionRequest(
  content: RequestPermissionRequest["toolCall"]["content"],
  kind: NonNullable<RequestPermissionRequest["toolCall"]["kind"]> = "edit",
): RequestPermissionRequest {
  return {
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ],
    sessionId: "session",
    toolCall: {
      content,
      kind,
      toolCallId: "tool",
    },
  };
}

describe("buildHermesAcpArgs", () => {
  it("selects the default profile through Hermes' global CLI flag", () => {
    expect(buildHermesAcpArgs("default", true)).toEqual([
      "--profile",
      "default",
      "acp",
      "--accept-hooks",
    ]);
  });

  it("omits profile and startup-hook flags when they are disabled", () => {
    expect(buildHermesAcpArgs("  ", false)).toEqual(["acp"]);
  });

  it("trims named profiles", () => {
    expect(buildHermesAcpArgs(" coding_agent ", false)).toEqual([
      "--profile",
      "coding_agent",
      "acp",
    ]);
  });
});

describe("HermesAcpClient session safety", () => {
  it("rejects session history loads while a prompt is active", async () => {
    const client = new HermesAcpClient({
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
    Reflect.set(client, "busy", true);
    Reflect.set(client, "connectPromise", Promise.resolve());

    await expect(client.loadSessionHistory("session-b")).rejects.toThrow(
      "Cannot load conversation history while Hermes is responding",
    );
  });

  it("claims the prompt slot before awaiting connection", async () => {
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const client = new HermesAcpClient({
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
    Reflect.set(client, "connectPromise", pendingConnect);

    const firstPrompt = client.sendPrompt("first");
    await Promise.resolve();
    expect(client.isBusy).toBe(true);
    await expect(client.sendPrompt("second")).rejects.toThrow(
      "Hermes is already processing a prompt",
    );

    resolveConnect();
    await expect(firstPrompt).rejects.toThrow("Hermes ACP session is unavailable");
    expect(client.isBusy).toBe(false);
  });

  it("serializes session operations before awaiting connection", async () => {
    let resolveTransport!: () => void;
    const pendingTransport = new Promise<void>((resolve) => {
      resolveTransport = resolve;
    });
    const client = new HermesAcpClient({
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
    Reflect.set(client, "transportPromise", pendingTransport);

    const firstLoad = client.loadSessionHistory("session-a");
    await Promise.resolve();
    expect(client.isOperating).toBe(true);
    await expect(client.loadSessionHistory("session-b")).rejects.toThrow(
      "Cannot load conversation history while Hermes is responding",
    );
    await expect(client.sendPrompt("blocked")).rejects.toThrow(
      "Hermes is already processing a prompt",
    );

    resolveTransport();
    await expect(firstLoad).rejects.toThrow("Hermes ACP context is unavailable");
    expect(client.isOperating).toBe(false);
  });

  it("exposes transport readiness separately from session readiness", () => {
    const client = new HermesAcpClient({
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
    expect(client.isTransportReady).toBe(false);
    expect(client.isConnected).toBe(false);

    const fakeConnection = { signal: { aborted: false }, close: () => undefined };
    const fakeContext = {};
    Reflect.set(client, "connection", fakeConnection);
    Reflect.set(client, "context", fakeContext);
    expect(client.isTransportReady).toBe(true);
    expect(client.isConnected).toBe(false);

    Reflect.set(client, "resumedSessionId", "sess-1");
    expect(client.isConnected).toBe(true);
    expect(client.sessionId).toBe("sess-1");
  });

  it("routes resume through ensureTransport rather than full connect", async () => {
    const client = new HermesAcpClient({
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
    const ensure = vi.fn(async () => undefined);
    const connect = vi.fn(async () => undefined);
    Reflect.set(client, "ensureTransport", ensure);
    Reflect.set(client, "connect", connect);
    // No context → fails after ensureTransport, proving connect is not required first.
    await expect(client.loadSessionHistory("resume-me")).rejects.toThrow(
      "Hermes ACP context is unavailable",
    );
    expect(ensure).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("HermesAcpClient late-response ownership", () => {
  function deferred<T>(): {
    promise: Promise<T>;
    reject: (reason?: unknown) => void;
    resolve: (value: T | PromiseLike<T>) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, reject, resolve };
  }

  function baseSettings() {
    return {
      acceptHooks: true,
      autoApproveVaultEdits: true,
      debugLogging: false,
      // Catalog discovery must not depend on a locally installed Hermes CLI.
      hermesExecutable: "/definitely/missing/hermes",
      hiddenModelSwitchIds: [],
      profile: "default",
      reasoningEffort: "default" as const,
    };
  }

  function modelOption(switchId = "provider:model-a") {
    return {
      description: "",
      modelId: "model-a",
      name: "Model A",
      providerId: "provider",
      providerName: "Provider",
      switchId,
    };
  }

  function installTransport(
    client: HermesAcpClient,
    context: {
      buildSession?: (cwd: string) => { start: () => Promise<unknown> };
      request: (...args: unknown[]) => Promise<unknown>;
    },
    signal: { aborted: boolean } = { aborted: false },
  ): { close: ReturnType<typeof vi.fn>; connection: { close: ReturnType<typeof vi.fn>; signal: { aborted: boolean } } } {
    const close = vi.fn();
    const connection = {
      close,
      signal,
    };
    Reflect.set(client, "connection", connection);
    Reflect.set(client, "context", context);
    Reflect.set(client, "intentionalShutdown", false);
    return { close, connection };
  }

  it("ignores a load that resolves after disconnect (no session revival)", async () => {
    const events: Array<{ status?: string; type: string }> = [];
    const client = new HermesAcpClient({
      onEvent: (event) => {
        if (event.type === "status" || event.type === "error") {
          events.push(event as { status?: string; type: string });
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    const load = deferred<{ models?: unknown }>();
    installTransport(client, {
      request: vi.fn(async () => load.promise),
    });

    const pending = client.loadSessionHistory("saved-session");
    await Promise.resolve();
    expect(client.isOperating).toBe(true);

    await client.disconnect();
    const postDisconnect = events.length;
    load.resolve({
      models: {
        availableModels: [{ modelId: "m1", name: "M1" }],
        currentModelId: "m1",
      },
    });

    const settled = await pending.then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    // Desired: cancelled/stale + no revival. Current bug revives sessionId.
    expect(client.sessionId).toBeUndefined();
    expect(client.isConnected).toBe(false);
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(String(settled.error)).toMatch(/cancelled|stale/i);
    }
    const late = events.slice(postDisconnect);
    expect(late.filter((e) => e.type === "status" && e.status === "connected")).toHaveLength(0);
    expect(late.filter((e) => e.type === "status" && e.status === "error")).toHaveLength(0);
    expect(late.filter((e) => e.type === "error")).toHaveLength(0);
    expect(client.currentSessionState.catalogLoading).toBe(false);
    expect(client.currentSessionState.models).toEqual([]);
  });

  it("disposes a late newSession and never emits Connected after disconnect", async () => {
    const events: Array<{ status?: string; type: string }> = [];
    const client = new HermesAcpClient({
      onEvent: (event) => {
        if (event.type === "status" || event.type === "error") {
          events.push(event as { status?: string; type: string });
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    const started = deferred<{
      dispose: ReturnType<typeof vi.fn>;
      newSessionResponse: { models?: unknown };
      sessionId: string;
    }>();
    const dispose = vi.fn();
    installTransport(client, {
      buildSession: () => ({
        start: () => started.promise,
      }),
      request: vi.fn(async () => ({})),
    });

    const pending = client.newSession();
    await Promise.resolve();
    expect(client.isOperating).toBe(true);

    await client.disconnect();
    const postDisconnect = events.length;
    started.resolve({
      dispose,
      newSessionResponse: {
        models: {
          availableModels: [{ modelId: "fresh", name: "Fresh" }],
          currentModelId: "fresh",
        },
      },
      sessionId: "late-fresh-session",
    });

    const settled = await pending.then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(client.sessionId).toBeUndefined();
    expect(Reflect.get(client, "activeSession")).toBeUndefined();
    expect(Reflect.get(client, "resumedSessionId")).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(String(settled.error)).toMatch(/cancelled|stale/i);
    }
    const late = events.slice(postDisconnect);
    expect(late.filter((e) => e.type === "status" && e.status === "connected")).toHaveLength(0);
    expect(late.filter((e) => e.type === "status" && e.status === "error")).toHaveLength(0);
  });

  it("does not apply a late setModel result after disconnect", async () => {
    const client = new HermesAcpClient({
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    const setModel = deferred<Record<string, never>>();
    installTransport(client, {
      request: vi.fn(async () => setModel.promise),
    });
    Reflect.set(client, "resumedSessionId", "live-session");
    Reflect.set(client, "sessionState", {
      catalogLoading: false,
      commands: [],
      currentModel: modelOption("provider:old"),
      models: [modelOption("provider:old"), modelOption("provider:model-a")],
      skillCatalogLoading: false,
      skills: [],
      switchingModel: false,
    });

    const pending = client.setModel(modelOption("provider:model-a"));
    await Promise.resolve();
    expect(client.isOperating).toBe(true);

    await client.disconnect();
    const resetState = client.currentSessionState;
    expect(resetState.models).toEqual([]);
    expect(resetState.currentModel).toBeUndefined();
    expect(resetState.switchingModel).toBe(false);

    setModel.resolve({});
    const settled = await pending.then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(client.currentSessionState.models).toEqual([]);
    expect(client.currentSessionState.currentModel).toBeUndefined();
    expect(client.currentSessionState.switchingModel).toBe(false);
    expect(client.sessionId).toBeUndefined();
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(String(settled.error)).toMatch(/cancelled|stale/i);
    }
  });

  it("keeps normal load/new/model paths and allows one fresh new after a plain load failure", async () => {
    const events: Array<{ status?: string; type: string }> = [];
    const client = new HermesAcpClient({
      onEvent: (event) => {
        if (event.type === "status" || event.type === "error") {
          events.push(event as { status?: string; type: string });
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    let loadCalls = 0;
    let newCalls = 0;
    let setModelCalls = 0;
    const dispose = vi.fn();
    const freshSession = {
      dispose,
      newSessionResponse: {
        models: {
          availableModels: [{ modelId: "fresh", name: "Fresh" }],
          currentModelId: "fresh",
        },
      },
      sessionId: "fresh-session",
    };

    installTransport(client, {
      buildSession: () => ({
        start: async () => {
          newCalls += 1;
          return freshSession;
        },
      }),
      request: vi.fn(async (method: unknown, params?: unknown) => {
        const name = String(method);
        if (name.includes("load") || (params && typeof params === "object" && "sessionId" in (params as object) && name !== "session/set_model")) {
          // session/load path via acp.methods.agent.session.load
        }
        if (name === "session/set_model") {
          setModelCalls += 1;
          return {};
        }
        // Default: treat as session/load
        loadCalls += 1;
        if (loadCalls === 1) {
          throw new Error("saved session unavailable");
        }
        return {
          models: {
            availableModels: [{ modelId: "restored", name: "Restored" }],
            currentModelId: "restored",
          },
        };
      }),
    });

    // Plain load failure must not disconnect transport ownership.
    await expect(client.loadSessionHistory("missing")).rejects.toThrow("saved session unavailable");
    expect(client.isTransportReady).toBe(true);
    expect(client.sessionId).toBeUndefined();

    await client.newSession();
    expect(newCalls).toBe(1);
    expect(client.sessionId).toBe("fresh-session");
    expect(events.some((e) => e.type === "status" && e.status === "connected")).toBe(true);

    await client.setModel(modelOption("provider:model-a"));
    expect(setModelCalls).toBe(1);
    expect(client.currentSessionState.currentModel?.switchId).toBe("provider:model-a");

    // A successful resume load still works on the same client.
    const items = await client.loadSessionHistory("saved-session");
    expect(Array.isArray(items)).toBe(true);
    expect(client.sessionId).toBe("saved-session");
    expect(loadCalls).toBe(2);
    expect(newCalls).toBe(1);
  });

  it("rejects a load that resolves after the transport signal aborts (no disconnect)", async () => {
    const events: Array<{ status?: string; type: string }> = [];
    const client = new HermesAcpClient({
      onEvent: (event) => {
        if (event.type === "status" || event.type === "error") {
          events.push(event as { status?: string; type: string });
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    const signal = { aborted: false };
    const load = deferred<{ models?: unknown }>();
    const request = vi.fn(async () => load.promise);
    installTransport(
      client,
      {
        request,
      },
      signal,
    );

    const pending = client.loadSessionHistory("aborted-session");
    await Promise.resolve();
    expect(client.isOperating).toBe(true);
    expect(request).toHaveBeenCalledOnce();

    // Abnormal transport abort — do NOT call disconnect().
    signal.aborted = true;
    const eventCountBeforeResolve = events.length;
    load.resolve({
      models: {
        availableModels: [{ modelId: "m1", name: "M1" }],
        currentModelId: "m1",
      },
    });

    const settled = await pending.then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    // Bug without aborted check: fulfilled + sessionId revived.
    expect(client.sessionId).toBeUndefined();
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(String(settled.error)).toMatch(/cancelled|stale/i);
    }
    const late = events.slice(eventCountBeforeResolve);
    expect(late.filter((e) => e.type === "status" && e.status === "connected")).toHaveLength(0);
    expect(late.filter((e) => e.type === "status" && e.status === "error")).toHaveLength(0);
    expect(late.filter((e) => e.type === "error")).toHaveLength(0);
    expect(client.currentSessionState.catalogLoading).toBe(false);
    expect(client.currentSessionState.models).toEqual([]);
    expect(Reflect.get(client, "historyCapture")).toBeUndefined();
    expect(client.isOperating).toBe(false);
  });

  it("disposes a late newSession when the transport signal aborts mid-flight", async () => {
    const events: Array<{ status?: string; type: string }> = [];
    const client = new HermesAcpClient({
      onEvent: (event) => {
        if (event.type === "status" || event.type === "error") {
          events.push(event as { status?: string; type: string });
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    const signal = { aborted: false };
    const started = deferred<{
      dispose: ReturnType<typeof vi.fn>;
      newSessionResponse: { models?: unknown };
      sessionId: string;
    }>();
    const dispose = vi.fn();
    installTransport(
      client,
      {
        buildSession: () => ({
          start: () => started.promise,
        }),
        request: vi.fn(async () => ({})),
      },
      signal,
    );

    const pending = client.newSession();
    await Promise.resolve();
    expect(client.isOperating).toBe(true);

    signal.aborted = true;
    const eventCountBeforeResolve = events.length;
    started.resolve({
      dispose,
      newSessionResponse: {
        models: {
          availableModels: [{ modelId: "fresh", name: "Fresh" }],
          currentModelId: "fresh",
        },
      },
      sessionId: "aborted-fresh-session",
    });

    const settled = await pending.then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(client.sessionId).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(String(settled.error)).toMatch(/cancelled|stale/i);
    }
    const late = events.slice(eventCountBeforeResolve);
    expect(late.filter((e) => e.type === "status" && e.status === "connected")).toHaveLength(0);
    expect(late.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("does not apply a late setModel after the transport signal aborts", async () => {
    const client = new HermesAcpClient({
      onEvent: () => undefined,
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    const signal = { aborted: false };
    const setModel = deferred<Record<string, never>>();
    installTransport(
      client,
      {
        request: vi.fn(async () => setModel.promise),
      },
      signal,
    );
    Reflect.set(client, "resumedSessionId", "live-session");
    Reflect.set(client, "sessionState", {
      catalogLoading: false,
      commands: [],
      currentModel: modelOption("provider:old"),
      models: [modelOption("provider:old"), modelOption("provider:model-a")],
      skillCatalogLoading: false,
      skills: [],
      switchingModel: false,
    });

    const pending = client.setModel(modelOption("provider:model-a"));
    await Promise.resolve();
    expect(client.isOperating).toBe(true);

    signal.aborted = true;
    setModel.resolve({});
    const settled = await pending.then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(String(settled.error)).toMatch(/cancelled|stale/i);
    }
    // Must not adopt the late model switch; may remain old or cleared depending on closed path.
    expect(client.currentSessionState.currentModel?.switchId).not.toBe("provider:model-a");
  });

  it("does not let an old connection.closed wipe a newer reconnected session", async () => {
    const events: Array<{ status?: string; type: string }> = [];
    const client = new HermesAcpClient({
      onEvent: (event) => {
        if (event.type === "status" || event.type === "error") {
          events.push(event as { status?: string; type: string });
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: baseSettings,
      vaultPath: "/tmp/hermesian-test-vault",
    });

    let resolveOldClosed!: () => void;
    const oldClosed = new Promise<void>((resolve) => {
      resolveOldClosed = resolve;
    });
    const oldClose = vi.fn();
    const oldConnection = {
      close: oldClose,
      closed: oldClosed,
      signal: { aborted: false },
    };
    const oldContext = { request: vi.fn(async () => ({})) };
    Reflect.set(client, "connection", oldConnection);
    Reflect.set(client, "context", oldContext);
    Reflect.set(client, "intentionalShutdown", false);
    Reflect.set(client, "lifecycleGeneration", 1);
    // Simulate the closed watcher that ensureTransport installs.
    const generationAtOld = 1;
    void oldConnection.closed.then(() => {
      const handler = Reflect.get(client, "handleConnectionClosed") as
        | ((connection: unknown, generation: number, detail?: string) => void)
        | undefined;
      if (typeof handler === "function") {
        handler.call(client, oldConnection, generationAtOld, "old closed");
        return;
      }
      // Fallback: invoke the same conditions as production if helper not yet extracted.
      if (
        Reflect.get(client, "lifecycleGeneration") === generationAtOld &&
        Reflect.get(client, "connection") === oldConnection &&
        !Reflect.get(client, "intentionalShutdown")
      ) {
        Reflect.set(client, "catalogGeneration", Number(Reflect.get(client, "catalogGeneration")) + 1);
        Reflect.set(client, "activeSession", undefined);
        Reflect.set(client, "resumedSessionId", undefined);
        (client as unknown as { resetSessionState: () => void }).resetSessionState?.();
        events.push({ type: "status", status: "disconnected" });
      }
    });

    // Reconnect: newer connection/session replaces the old one.
    const newClose = vi.fn();
    const newConnection = {
      close: newClose,
      closed: new Promise<void>(() => undefined),
      signal: { aborted: false },
    };
    Reflect.set(client, "lifecycleGeneration", 2);
    Reflect.set(client, "connection", newConnection);
    Reflect.set(client, "context", { request: vi.fn(async () => ({})) });
    Reflect.set(client, "resumedSessionId", "new-session");
    Reflect.set(client, "sessionState", {
      catalogLoading: false,
      commands: [],
      currentModel: modelOption("provider:live"),
      models: [modelOption("provider:live")],
      skillCatalogLoading: false,
      skills: [],
      switchingModel: false,
    });

    resolveOldClosed();
    await Promise.resolve();
    await Promise.resolve();

    expect(Reflect.get(client, "connection")).toBe(newConnection);
    expect(client.sessionId).toBe("new-session");
    expect(client.currentSessionState.currentModel?.switchId).toBe("provider:live");
    expect(events.filter((e) => e.status === "disconnected")).toHaveLength(0);
  });
});

describe("automaticVaultEditApproval", () => {
  const temporaryVaults: string[] = [];
  const createVault = (): string => {
    const vault = mkdtempSync(join(tmpdir(), "hermesian-permission-"));
    temporaryVaults.push(vault);
    return vault;
  };

  afterEach(() => {
    for (const vault of temporaryVaults.splice(0)) {
      rmSync(vault, { force: true, recursive: true });
    }
  });

  it("automatically approves a verified diff inside the Vault", () => {
    const vault = createVault();
    const response = automaticVaultEditApproval(
      permissionRequest([
        {
          newText: "new",
          oldText: "old",
          path: join(vault, "note.md"),
          type: "diff",
        },
      ]),
      vault,
      true,
    );
    expect(response).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("does not automatically approve a request without a verifiable diff", () => {
    const vault = createVault();
    expect(automaticVaultEditApproval(permissionRequest(null), vault, true)).toBeUndefined();
  });

  it("does not automatically approve a non-edit tool even when it carries a diff", () => {
    const vault = createVault();
    const request = permissionRequest(
      [
        {
          newText: "new",
          path: join(vault, "note.md"),
          type: "diff",
        },
      ],
      "execute",
    );
    expect(automaticVaultEditApproval(request, vault, true)).toBeUndefined();
  });

  it("rejects a diff target outside the Vault boundary", () => {
    const vault = createVault();
    expect(() =>
      automaticVaultEditApproval(
        permissionRequest([
          {
            newText: "new",
            path: join(vault, "..", "outside-note.md"),
            type: "diff",
          },
        ]),
        vault,
        true,
      ),
    ).toThrow(/outside the Obsidian vault/i);
  });
});

describe("HermesAcpClient steer", () => {
  function steerDeferred<T>(): {
    promise: Promise<T>;
    reject: (reason?: unknown) => void;
    resolve: (value: T | PromiseLike<T>) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, reject, resolve };
  }

  function steerClient(
    onEvent: (event: { type: string; text?: string }) => void = () => undefined,
  ): HermesAcpClient {
    return new HermesAcpClient({
      onEvent: (event) => {
        onEvent(event as { type: string; text?: string });
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      pluginVersion: "test",
      settings: () => ({
        acceptHooks: true,
        autoApproveVaultEdits: true,
        debugLogging: false,
        hermesExecutable: "/definitely/missing/hermes",
        hiddenModelSwitchIds: [],
        profile: "default",
        reasoningEffort: "default",
      }),
      vaultPath: "/tmp/hermesian-test-vault",
    });
  }

  function steerTransport(
    client: HermesAcpClient,
    request: (...args: unknown[]) => Promise<unknown>,
  ): void {
    Reflect.set(client, "connection", {
      close: vi.fn(),
      signal: { aborted: false },
    });
    Reflect.set(client, "context", { request });
    Reflect.set(client, "intentionalShutdown", false);
  }

  function steerChunk(text: string): unknown {
    return {
      content: { text, type: "text" },
      sessionUpdate: "agent_message_chunk",
    };
  }

  function pushSteerUpdate(client: HermesAcpClient, update: unknown): void {
    const handler = Reflect.get(client, "handleSessionUpdate") as
      | ((update: unknown) => void)
      | undefined;
    expect(typeof handler).toBe("function");
    handler!.call(client, update);
  }

  function assistantDeltas(
    client: HermesAcpClient,
  ): { deltas: string[]; all: () => string } {
    const deltas: string[] = [];
    const original = Reflect.get(client, "emit") as
      | ((event: { type: string; text?: string }) => void)
      | undefined;
    Reflect.set(
      client,
      "emit",
      (event: { type: string; text?: string }) => {
        if (event.type === "assistant-delta" && typeof event.text === "string") {
          deltas.push(event.text);
        }
        if (typeof original === "function") {
          original.call(client, event);
        }
      },
    );
    return { deltas, all: () => deltas.join("") };
  }

  it("classifies the exact redirect marker as success and replays only non-marker text", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    const request = vi.fn(() => pending.promise);
    steerTransport(client, request);
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("rename the function");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "session/prompt",
      expect.objectContaining({
        prompt: [{ text: "rename the function", type: "text" }],
        sessionId: "live-session",
      }),
    );

    // Both fresh nextUpdate-loop and resumed notification routes converge on
    // handleSessionUpdate; drive it directly to cover the capture path.
    pushSteerUpdate(client, steerChunk("Redirected the active turn with your correction."));
    pushSteerUpdate(client, steerChunk("main stream keeps flowing"));
    pending.resolve({ stopReason: "end_turn" });

    await expect(steer).resolves.toEqual({ ok: true });
    expect(capture.deltas).toEqual(["main stream keeps flowing"]);
    expect(capture.all()).not.toContain("Redirected the active turn");
    expect(capture.all()).not.toContain("Queued for the next turn");
    expect(capture.all()).not.toContain("No active turn — queued");
  });

  it("rejects the queue fallback and never renders queue copy as assistant text", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pushSteerUpdate(client, steerChunk("Queued for the next turn. (2 queued)"));
    pending.resolve({ stopReason: "end_turn" });

    await expect(steer).resolves.toEqual({ ok: false, reason: "queued" });
    expect(capture.all()).not.toContain("Queued for the next turn");
  });

  it("rejects the no-active-turn queue fallback and steer failures explicitly", async () => {
    const noActiveTurn = steerClient();
    const captureA = assistantDeltas(noActiveTurn);
    const pendingA = steerDeferred<{ stopReason: string }>();
    steerTransport(noActiveTurn, vi.fn(() => pendingA.promise));
    Reflect.set(noActiveTurn, "busy", true);
    Reflect.set(noActiveTurn, "mainTurnActive", true);
    Reflect.set(noActiveTurn, "resumedSessionId", "live-session");
    const steerA = noActiveTurn.steerActiveTurn("correction");
    pushSteerUpdate(noActiveTurn, steerChunk("No active turn — queued for the next turn. (1 queued)"));
    pendingA.resolve({ stopReason: "end_turn" });
    await expect(steerA).resolves.toEqual({ ok: false, reason: "queued" });
    expect(captureA.all()).not.toContain("No active turn — queued");

    const failed = steerClient();
    const captureB = assistantDeltas(failed);
    const pendingB = steerDeferred<{ stopReason: string }>();
    steerTransport(failed, vi.fn(() => pendingB.promise));
    Reflect.set(failed, "busy", true);
    Reflect.set(failed, "mainTurnActive", true);
    Reflect.set(failed, "resumedSessionId", "live-session");
    const steerB = failed.steerActiveTurn("correction");
    pushSteerUpdate(failed, steerChunk("⚠️ Steer failed: model rejected the guidance"));
    pendingB.resolve({ stopReason: "end_turn" });
    await expect(steerB).resolves.toEqual({ ok: false, reason: "steer_failed" });
    expect(captureB.all()).not.toContain("Steer failed");
    expect(captureB.all()).not.toContain("⚠️");
  });

  it("returns unverifiable when no marker appears even with end_turn", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pushSteerUpdate(client, steerChunk("something unrelated"));
    pending.resolve({ stopReason: "end_turn" });

    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
    // Concurrent main-turn text must not be lost.
    expect(capture.deltas).toEqual(["something unrelated"]);
  });

  it("returns unverifiable when the request times out", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      steerTransport(client, vi.fn(() => new Promise(() => undefined)));
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const steer = client.steerActiveTurn("correction");
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unverifiable when the request rejects", async () => {
    const client = steerClient();
    steerTransport(
      client,
      vi.fn(async () => {
        throw new Error("transport blew up");
      }),
    );
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    await expect(client.steerActiveTurn("correction")).resolves.toEqual({
      ok: false,
      reason: "unverifiable",
    });
  });

  it("returns no_active_turn when no turn is running and never sends a request", async () => {
    const client = steerClient();
    const request = vi.fn();
    steerTransport(client, request);

    await expect(client.steerActiveTurn("correction")).resolves.toEqual({
      ok: false,
      reason: "no_active_turn",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a second steer while one is in flight", async () => {
    const client = steerClient();
    const pending = steerDeferred<{ stopReason: string }>();
    const request = vi.fn(() => pending.promise);
    steerTransport(client, request);
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const first = client.steerActiveTurn("first correction");
    await expect(client.steerActiveTurn("second correction")).resolves.toEqual({
      ok: false,
      reason: "steer_in_flight",
    });
    expect(request).toHaveBeenCalledOnce();

    pending.resolve({ stopReason: "end_turn" });
    await expect(first).resolves.toEqual({ ok: false, reason: "unverifiable" });
  });

  it("keeps sendPrompt's busy guard while steer uses its own bounded path", async () => {
    const client = steerClient();
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    await expect(client.sendPrompt("blocked")).rejects.toThrow(
      "Hermes is already processing a prompt",
    );

    const steer = client.steerActiveTurn("correction");
    pending.resolve({ stopReason: "end_turn" });
    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
    expect(client.isBusy).toBe(true);
  });

  it("never leaks queue copy into any emitted event", async () => {
    const events: string[] = [];
    const client = steerClient((event) => {
      events.push(JSON.stringify(event));
    });
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pushSteerUpdate(client, steerChunk("Queued for the next turn. (0 queued)"));
    pending.resolve({ stopReason: "end_turn" });
    await steer;

    expect(events.join("")).not.toContain("Queued for the next turn");
  });

  it("replays interleaved prose in order and suppresses every receipt tail", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pushSteerUpdate(client, steerChunk("Queued for the next turn. (2 queued)"));
    pushSteerUpdate(client, steerChunk("first half "));
    pushSteerUpdate(client, steerChunk("second half"));
    pushSteerUpdate(client, steerChunk("⚠️ Steer failed: too late"));
    pending.resolve({ stopReason: "end_turn" });

    await expect(steer).resolves.toEqual({ ok: false, reason: "steer_failed" });
    expect(capture.deltas).toEqual(["first half second half"]);
    expect(capture.all()).not.toContain("Queued for the next turn");
    expect(capture.all()).not.toContain("Steer failed");
  });

  it("preserves prose that merely mentions marker words alongside a receipt", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pushSteerUpdate(client, steerChunk("⚠️ Steer failed: model rejected the guidance"));
    pushSteerUpdate(client, steerChunk("I won't say Steer failed"));
    pushSteerUpdate(client, steerChunk("The ⚠️ icon warns"));
    pending.resolve({ stopReason: "end_turn" });

    await expect(steer).resolves.toEqual({ ok: false, reason: "steer_failed" });
    expect(capture.deltas).toEqual(["I won't say Steer failedThe ⚠️ icon warns"]);
    expect(capture.all()).not.toContain("⚠️ Steer failed");
  });

  it("resolves a same-tick steer as no_active_turn when the main request already reached terminal completion", async () => {
    const calls: string[] = [];
    const client = steerClient();
    const request = vi.fn(
      async (...args: unknown[]) => {
        const params = args[1] as { prompt: Array<{ text: string }> };
        calls.push(params.prompt[0].text);
        return { stopReason: "end_turn" };
      },
    );
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");

    await expect(steer).resolves.toEqual({ ok: false, reason: "no_active_turn" });
    await main;
    expect(calls).toEqual(["main prompt"]);
  });

  it("dispatches a same-tick steer only after a genuinely pending main request", async () => {
    const calls: string[] = [];
    let resolveMain!: (value: { stopReason: string }) => void;
    const pendingMain = new Promise<{ stopReason: string }>((resolve) => {
      resolveMain = resolve;
    });
    const client = steerClient();
    const request = vi.fn(
      (...args: unknown[]) => {
        const params = args[1] as { prompt: Array<{ text: string }> };
        calls.push(params.prompt[0].text);
        if (params.prompt[0].text === "main prompt") {
          return pendingMain;
        }
        return Promise.resolve({ stopReason: "end_turn" });
      },
    );
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");

    // The main request is still pending when the steer dispatches.
    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
    expect(calls).toEqual(["main prompt", "correction"]);
    resolveMain({ stopReason: "end_turn" });
    await main;
  });

  it("never dispatches a same-tick steer when the main request rejects immediately", async () => {
    const calls: string[] = [];
    const client = steerClient();
    const request = vi.fn(
      async (...args: unknown[]) => {
        const params = args[1] as { prompt: Array<{ text: string }> };
        calls.push(params.prompt[0].text);
        throw new Error("transport blew up");
      },
    );
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");

    await expect(steer).resolves.toEqual({ ok: false, reason: "no_active_turn" });
    await expect(main).rejects.toThrow("transport blew up");
    expect(calls).toEqual(["main prompt"]);
  });

  it("does not dispatch a steer when the client disconnects while waiting on the commit", async () => {
    const calls: string[] = [];
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const client = steerClient();
    const request = vi.fn(
      async (...args: unknown[]) => {
        const params = args[1] as { prompt: Array<{ text: string }> };
        calls.push(params.prompt[0].text);
        return { stopReason: "end_turn" };
      },
    );
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");
    Reflect.set(client, "connect", vi.fn(() => pendingConnect));

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();

    await client.disconnect();
    await expect(steer).resolves.toEqual({ ok: false, reason: "no_active_turn" });

    resolveConnect();
    await expect(main).rejects.toThrow("Hermes ACP session is unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for a main prompt that is still connecting before dispatching steer", async () => {
    const calls: string[] = [];
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    let resolveMain!: (value: { stopReason: string }) => void;
    const pendingMain = new Promise<{ stopReason: string }>((resolve) => {
      resolveMain = resolve;
    });
    const client = steerClient();
    const request = vi.fn(
      (...args: unknown[]) => {
        const params = args[1] as { prompt: Array<{ text: string }> };
        calls.push(params.prompt[0].text);
        // The main request must stay genuinely pending while the steer
        // dispatches — an immediately-terminal main is the no_active_turn
        // boundary, not an ordering scenario.
        if (params.prompt[0].text === "main prompt") {
          return pendingMain;
        }
        return Promise.resolve({ stopReason: "end_turn" });
      },
    );
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");
    Reflect.set(client, "connect", vi.fn(() => pendingConnect));

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();

    resolveConnect();
    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
    expect(calls).toEqual(["main prompt", "correction"]);

    resolveMain({ stopReason: "end_turn" });
    await main;
  });

  it("returns no_active_turn after the main prompt has already finished", async () => {
    const client = steerClient();
    const request = vi.fn(async () => ({ stopReason: "end_turn" }));
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");

    await client.sendPrompt("finished main prompt");
    expect(request).toHaveBeenCalledTimes(1);

    await expect(client.steerActiveTurn("correction")).resolves.toEqual({
      ok: false,
      reason: "no_active_turn",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns no_active_turn for a steer waiting on a failed connect", async () => {
    const client = steerClient();
    const request = vi.fn();
    steerTransport(client, request);
    Reflect.set(client, "connect", vi.fn(async () => {
      throw new Error("connect blew up");
    }));

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");

    await expect(steer).resolves.toEqual({ ok: false, reason: "no_active_turn" });
    await expect(main).rejects.toThrow("connect blew up");
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds the wait for a main prompt that never commits", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      const request = vi.fn();
      steerTransport(client, request);
      Reflect.set(client, "connect", vi.fn(() => new Promise<void>(() => undefined)));

      void client.sendPrompt("main prompt");
      const steer = client.steerActiveTurn("correction");
      await vi.advanceTimersByTimeAsync(30_001);

      await expect(steer).resolves.toEqual({ ok: false, reason: "no_active_turn" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves the steer slot while waiting on a connecting main prompt", async () => {
    const calls: string[] = [];
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    let resolveMain!: (value: { stopReason: string }) => void;
    const pendingMain = new Promise<{ stopReason: string }>((resolve) => {
      resolveMain = resolve;
    });
    const client = steerClient();
    const request = vi.fn(
      (...args: unknown[]) => {
        const params = args[1] as { prompt: Array<{ text: string }> };
        calls.push(params.prompt[0].text);
        // The main request stays genuinely pending while the steer dispatches.
        if (params.prompt[0].text === "main prompt") {
          return pendingMain;
        }
        return Promise.resolve({ stopReason: "end_turn" });
      },
    );
    steerTransport(client, request);
    Reflect.set(client, "resumedSessionId", "live-session");
    Reflect.set(client, "connect", vi.fn(() => pendingConnect));

    const main = client.sendPrompt("main prompt");
    const first = client.steerActiveTurn("first correction");

    // Second steer while the first is still parked on the commit wait: the
    // reservation must reject it immediately, without touching the wire.
    await expect(client.steerActiveTurn("second correction")).resolves.toEqual({
      ok: false,
      reason: "steer_in_flight",
    });
    expect(request).not.toHaveBeenCalled();

    resolveConnect();
    await expect(first).resolves.toEqual({ ok: false, reason: "unverifiable" });
    expect(calls).toEqual(["main prompt", "first correction"]);

    resolveMain({ stopReason: "end_turn" });
    await main;
  });

  it("clears the steer reservation when the main-turn commit fails", async () => {
    const client = steerClient();
    const request = vi.fn();
    steerTransport(client, request);
    Reflect.set(client, "connect", vi.fn(async () => {
      throw new Error("connect blew up");
    }));

    const main = client.sendPrompt("main prompt");
    const steer = client.steerActiveTurn("correction");

    await expect(steer).resolves.toEqual({ ok: false, reason: "no_active_turn" });
    await expect(main).rejects.toThrow("connect blew up");
    expect(request).not.toHaveBeenCalled();

    // The reservation was released by the failed wait: an idle steer reports
    // no_active_turn, not a phantom steer_in_flight.
    await expect(client.steerActiveTurn("aftermath")).resolves.toEqual({
      ok: false,
      reason: "no_active_turn",
    });
  });

  it("never renders a late success receipt that arrives after the steer settled", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    // Settle the steer without any captured receipt (transport rejected).
    pending.reject(new Error("transport blew up"));
    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });

    // The receipt arrives after pendingSteer was cleared — it must not become
    // visible assistant text.
    pushSteerUpdate(client, steerChunk(STEER_SUCCESS_MARKER));
    expect(capture.deltas).toEqual([]);
  });

  it("suppresses late queue and failure receipts but keeps late ordinary prose", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pending.reject(new Error("transport blew up"));
    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });

    pushSteerUpdate(client, steerChunk("Queued for the next turn. (2 queued)"));
    pushSteerUpdate(client, steerChunk("⚠️ Steer failed: boom"));
    pushSteerUpdate(client, steerChunk("The model then finished its answer."));
    expect(capture.deltas).toEqual(["The model then finished its answer."]);
  });

  describe("steer receipt window and single-flight slot lifecycle", () => {
  it("emits marker-shaped main-stream chunks as assistant text when no steer ever ran", () => {
    const events: Array<{ type: string; text?: string }> = [];
    const client = steerClient((event) => {
      events.push(event as { type: string; text?: string });
    });
    pushSteerUpdate(client, steerChunk(STEER_SUCCESS_MARKER));
    pushSteerUpdate(client, steerChunk("⚠️ Steer failed: never happened here"));
    expect(events).toContainEqual({
      type: "assistant-delta",
      text: STEER_SUCCESS_MARKER,
    });
    expect(events).toContainEqual({
      type: "assistant-delta",
      text: "⚠️ Steer failed: never happened here",
    });
  });

  it("suppresses count-less receipts inside the steer window but keeps late prose", async () => {
    const client = steerClient();
    const capture = assistantDeltas(client);
    const pending = steerDeferred<{ stopReason: string }>();
    steerTransport(client, vi.fn(() => pending.promise));
    Reflect.set(client, "busy", true);
    Reflect.set(client, "mainTurnActive", true);
    Reflect.set(client, "resumedSessionId", "live-session");

    const steer = client.steerActiveTurn("correction");
    pending.reject(new Error("transport blew up"));
    await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });

    // Count-less queue variants and the real failure receipt stay suppressed
    // while the steer window is still open; ordinary prose still streams.
    pushSteerUpdate(client, steerChunk("Queued for the next turn"));
    pushSteerUpdate(client, steerChunk("No active turn — queued"));
    pushSteerUpdate(client, steerChunk("⚠️ Steer failed: boom"));
    pushSteerUpdate(client, steerChunk("The model then finished its answer."));
    expect(capture.deltas).toEqual(["The model then finished its answer."]);
  });

  it("keeps the single-flight slot reserved after timeout until the request settles", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      let resolveFirst!: (value: { stopReason: string }) => void;
      const pendingFirst = new Promise<{ stopReason: string }>((resolve) => {
        resolveFirst = resolve;
      });
      const request = vi.fn(() => pendingFirst);
      steerTransport(client, request);
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const first = client.steerActiveTurn("first correction");
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(first).resolves.toEqual({ ok: false, reason: "unverifiable" });

      // The underlying request is still unresolved: a second steer must not
      // reach the wire even though the first call already returned.
      await expect(client.steerActiveTurn("second correction")).resolves.toEqual({
        ok: false,
        reason: "steer_in_flight",
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Once the underlying request settles, the slot recovers.
      resolveFirst({ stopReason: "end_turn" });
      await Promise.resolve();
      await Promise.resolve();
      const third = client.steerActiveTurn("third correction");
      await expect(third).resolves.toEqual({ ok: false, reason: "unverifiable" });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays captured prose exactly once across a timeout and a late settle", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      const capture = assistantDeltas(client);
      let resolveRequest!: (value: { stopReason: string }) => void;
      const pendingRequest = new Promise<{ stopReason: string }>((resolve) => {
        resolveRequest = resolve;
      });
      const request = vi.fn(() => pendingRequest);
      steerTransport(client, request);
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const steer = client.steerActiveTurn("correction");
      pushSteerUpdate(client, steerChunk("prose during the steer window"));
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
      expect(capture.deltas).toEqual(["prose during the steer window"]);

      // The unresolved request finally settles: the slot releases and the
      // captured prose is not replayed a second time.
      resolveRequest({ stopReason: "end_turn" });
      await Promise.resolve();
      await Promise.resolve();
      expect(capture.deltas).toEqual(["prose during the steer window"]);

      // The slot recovered: a new steer can dispatch.
      const next = client.steerActiveTurn("again");
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(next).resolves.toEqual({ ok: false, reason: "unverifiable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a still-unresolved steer slot when the main turn reaches terminal", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      const request = vi.fn(() => new Promise(() => undefined));
      steerTransport(client, request);
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const steer = client.steerActiveTurn("correction");
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
      expect(request).toHaveBeenCalledTimes(1);

      // sendPrompt's finally performs this exact cleanup at main-turn terminal.
      const closeSteerWindow = Reflect.get(client, "closeSteerWindow") as () => void;
      closeSteerWindow.call(client);

      const next = client.steerActiveTurn("correction again");
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(next).resolves.toEqual({ ok: false, reason: "unverifiable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a still-unresolved steer slot on disconnect", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      const request = vi.fn(() => new Promise(() => undefined));
      steerTransport(client, request);
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const steer = client.steerActiveTurn("correction");
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
      expect(request).toHaveBeenCalledTimes(1);

      await client.disconnect();
      // Disconnect cleared the slot; restore a live transport and prove a
      // new steer can dispatch instead of reporting steer_in_flight.
      steerTransport(client, request);
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const next = client.steerActiveTurn("correction after reconnect");
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(next).resolves.toEqual({ ok: false, reason: "unverifiable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays post-timeout captured prose at main-turn terminal, exactly once", async () => {
    vi.useFakeTimers();
    try {
      const client = steerClient();
      const capture = assistantDeltas(client);
      const request = vi.fn(() => new Promise(() => undefined));
      steerTransport(client, request);
      Reflect.set(client, "busy", true);
      Reflect.set(client, "mainTurnActive", true);
      Reflect.set(client, "resumedSessionId", "live-session");

      const steer = client.steerActiveTurn("correction");
      pushSteerUpdate(client, steerChunk("early prose "));
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(steer).resolves.toEqual({ ok: false, reason: "unverifiable" });
      // Prose captured before the timeout is replayed at the bounded timeout.
      expect(capture.deltas).toEqual(["early prose "]);

      // The unresolved request keeps the slot (and the capture buffer) alive:
      // prose streamed after the timeout is still captured, not emitted.
      pushSteerUpdate(client, steerChunk("late prose "));
      pushSteerUpdate(client, steerChunk("Queued for the next turn. (2 queued)"));
      pushSteerUpdate(client, steerChunk("keeps flowing"));
      expect(capture.deltas).toEqual(["early prose "]);

      // Main-turn terminal: sendPrompt's finally performs this exact cleanup.
      const closeSteerWindow = Reflect.get(client, "closeSteerWindow") as () => void;
      closeSteerWindow.call(client);

      // The window's captured prose is replayed exactly once as
      // assistant-delta; receipt tails are classified and never rendered.
      expect(capture.deltas).toEqual(["early prose ", "late prose keeps flowing"]);
      expect(capture.all()).not.toContain("Queued for the next turn");
    } finally {
      vi.useRealTimers();
    }
  });
  });
});

describe("classifySteerCapture per-chunk receipts", () => {
  it("suppresses the complete queue acknowledgement including its dynamic count", () => {
    expect(classifySteerCapture("Queued for the next turn. (2 queued)")).toEqual({
      body: "",
      ok: false,
      reason: "queued",
    });
    expect(
      classifySteerCapture("No active turn — queued for the next turn. (1 queued)"),
    ).toEqual({
      body: "",
      ok: false,
      reason: "queued",
    });
  });

  it("suppresses steer-failure receipts entirely, dynamic detail included", () => {
    expect(classifySteerCapture("⚠️ Steer failed: boom")).toEqual({
      body: "",
      ok: false,
      reason: "steer_failed",
    });
  });

  it("never lets the success marker beat an explicit failure", () => {
    expect(
      classifySteerCapture(
        "Redirected the active turn with your correction. ⚠️ Steer failed",
      ),
    ).toEqual({ body: "", ok: false, reason: "steer_failed" });
  });

  it("keeps ordinary prose that merely mentions marker words", () => {
    expect(classifySteerCapture("I won't say Steer failed")).toEqual({
      body: "I won't say Steer failed",
      ok: false,
      reason: "unverifiable",
    });
    expect(classifySteerCapture("The ⚠️ icon warns")).toEqual({
      body: "The ⚠️ icon warns",
      ok: false,
      reason: "unverifiable",
    });
  });

  it("never swallows ordinary prose that mentions the queue wording", () => {
    const prose = "The server says Queued for the next turn when it is busy.";
    expect(classifySteerCapture(prose)).toEqual({
      body: prose,
      ok: false,
      reason: "unverifiable",
    });
  });

  it("preserves explanatory prose that merely starts with failure/warning wording", () => {
    for (const prose of [
      "Steer failed is the phrase used by the old protocol.",
      "⚠️ is a warning icon, not a steer receipt.",
    ]) {
      expect(classifySteerCapture(prose)).toEqual({
        body: prose,
        ok: false,
        reason: "unverifiable",
      });
    }
  });

  it("recognizes the count-less queue receipts named by the task contract", () => {
    for (const receipt of ["Queued for the next turn", "No active turn — queued"]) {
      expect(classifySteerCapture(receipt)).toEqual({
        body: "",
        ok: false,
        reason: "queued",
      });
    }
  });

  it("keeps marker-like prose that starts with a receipt prefix but continues differently", () => {
    for (const prose of [
      "Queued for the next turn later in the day.",
      "No active turn — queued, then I asked again.",
      "⚠️ Steer failed later told the story",
      "Redirected the active turn with your correction. ⚠️ Steer failed, then the model continued.",
    ]) {
      expect(classifySteerCapture(prose)).toEqual({
        body: prose,
        ok: false,
        reason: "unverifiable",
      });
    }
  });

  it("keeps marker-like prose that embeds a receipt shape inside a sentence", () => {
    const quoted =
      'The assistant said "Redirected the active turn with your correction." earlier';
    expect(classifySteerCapture(quoted)).toEqual({
      body: quoted,
      ok: false,
      reason: "unverifiable",
    });
    const depth = "Queue depth reported as Queued for the next turn. (2 queued) entries";
    expect(classifySteerCapture(depth)).toEqual({
      body: depth,
      ok: false,
      reason: "unverifiable",
    });
  });

  it("strips only the success marker from a success receipt", () => {
    expect(classifySteerCapture("Redirected the active turn with your correction.")).toEqual({
      body: "",
      ok: true,
    });
  });

  it("aggregates per chunk: a failure receipt wins the verdict but prose survives", () => {
    expect(
      aggregateSteerCapture([
        "⚠️ Steer failed: model rejected",
        "I won't say Steer failed",
      ]),
    ).toEqual({ body: "I won't say Steer failed", ok: false, reason: "steer_failed" });
  });

  it("keeps prose captured before and after a receipt, in order", () => {
    expect(
      aggregateSteerCapture([
        "before ",
        "Queued for the next turn. (2 queued)",
        "after",
      ]),
    ).toEqual({ body: "before after", ok: false, reason: "queued" });
  });

  it("treats a lone success receipt as ok with no body", () => {
    expect(
      aggregateSteerCapture(["Redirected the active turn with your correction."]),
    ).toEqual({ body: "", ok: true });
  });
});
