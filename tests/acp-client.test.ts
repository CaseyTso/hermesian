import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import {
  automaticVaultEditApproval,
  buildHermesAcpArgs,
  HermesAcpClient,
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
