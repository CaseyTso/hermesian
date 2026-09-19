import { describe, expect, it, vi, beforeEach } from "vitest";

import { HermesAcpClient } from "../src/acp-client";
import { ConversationController } from "../src/conversation-controller";
import {
  type PersistedConversationWorkspace,
  createConversationWorkspace,
  updateConversationTab,
} from "../src/conversation-tabs";
import { deriveConversationControlAvailability } from "../src/conversation-runtime";
import type { HermesModelOption } from "../src/types";

let catalogPromise: Promise<any> | undefined;

vi.mock("../src/hermes-model-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hermes-model-catalog")>();
  return {
    ...actual,
    loadHermesModelCatalog: vi.fn(async () => {
      if (catalogPromise) {
        return catalogPromise;
      }
      return {
        currentProviderId: "custom",
        models: [
          {
            description: "Default Custom Gemini",
            modelId: "gemini",
            name: "Gemini",
            providerId: "custom",
            providerName: "Custom",
            switchId: "custom:gemini",
          },
        ],
        providers: [
          {
            id: "custom",
            label: "Custom Provider",
            models: [
              {
                description: "Default Custom Gemini",
                modelId: "gemini",
                name: "Gemini",
                providerId: "custom",
                providerName: "Custom",
                switchId: "custom:gemini",
              },
            ],
          },
        ],
      };
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function modelOption(switchId: string, name?: string, providerId?: string): HermesModelOption {
  const parts = switchId.split(":");
  const prov = providerId ?? parts[0] ?? "test-provider";
  const model = parts.slice(1).join(":") || switchId;
  return {
    description: `Test model ${switchId}`,
    modelId: model,
    name: name ?? model,
    providerId: prov,
    providerName: prov.toUpperCase(),
    switchId,
  };
}

function createMockClient(options: {
  desiredModel?: (sessionId?: string) => HermesModelOption | undefined;
  requestHandler?: (method: string, params: any) => Promise<unknown>;
  resumedSessionId?: string;
}) {
  const calls: Array<{ method: string; params: any }> = [];
  const events: any[] = [];
  const client = new HermesAcpClient({
    desiredModel: options.desiredModel,
    onEvent: (event) => {
      events.push(event);
    },
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

  const freshPrompt = vi.fn(async () => {});
  const freshSession = {
    dispose: vi.fn(),
    newSessionResponse: {
      models: {
        availableModels: [{ modelId: "gemini", name: "Gemini" }],
        currentModelId: "custom:gemini",
      },
    },
    nextUpdate: vi.fn(async () => ({ kind: "stop" as const, stopReason: "end_turn" })),
    prompt: freshPrompt,
    sessionId: "fresh-session-xyz",
  };

  const request = vi.fn(async (method: string, params: any) => {
    calls.push({ method, params });
    if (options.requestHandler) {
      const custom = await options.requestHandler(method, params);
      if (custom !== undefined) {
        return custom;
      }
    }
    if (method === "session/load") {
      return {
        models: {
          availableModels: [
            { modelId: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
          ],
          currentModelId: "custom:gemini",
        },
      };
    }
    if (method === "session/set_model") {
      return {};
    }
    if (method === "session/set_config_option") {
      return {
        configOptions: [],
        _meta: {
          applied: true,
          config_id: params.configId,
          effort: params.value,
          hermesian_version: 1,
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
  Reflect.set(client, "context", {
    buildSession: () => ({
      start: async () => freshSession,
    }),
    request,
  });
  if (options.resumedSessionId !== undefined) {
    Reflect.set(client, "resumedSessionId", options.resumedSessionId);
  }
  Reflect.set(client, "intentionalShutdown", false);

  return { calls, client, events, freshPrompt, freshSession, request };
}

beforeEach(() => {
  catalogPromise = undefined;
});

describe("S3 model route restoration on session reconnect/restart", () => {
  it("restores exact saved named provider:model route on loadSessionHistory before ready/first prompt, even backend reports custom:gemini", async () => {
    const customNamedModel: HermesModelOption = {
      description: "Custom Future Grok proxy",
      modelId: "grok-2",
      name: "Grok 2",
      providerId: "custom:future-grok",
      providerName: "Future Grok",
      switchId: "custom:future-grok:grok-2",
    };

    const { calls, client } = createMockClient({
      desiredModel: (sessionId) => (sessionId === "sess-1" ? customNamedModel : undefined),
    });

    const items = await client.loadSessionHistory("sess-1");
    expect(Array.isArray(items)).toBe(true);

    expect(calls[0].method).toBe("session/load");
    expect(calls[0].params.sessionId).toBe("sess-1");

    expect(calls[1].method).toBe("session/set_model");
    expect(calls[1].params).toEqual({
      modelId: "custom:future-grok:grok-2",
      sessionId: "sess-1",
    });

    expect(client.currentSessionState.currentModel).toEqual(customNamedModel);

    await client.sendPrompt("test prompt");
    const setModelCalls = calls.filter((c) => c.method === "session/set_model");
    expect(setModelCalls).toHaveLength(1);

    expect(calls[2].method).toBe("session/set_config_option");
    expect(calls[3].method).toBe("session/prompt");
  });

  it("restores colon-tagged switch IDs without mangling (e.g. ollama:qwen2.5:7b-instruct)", async () => {
    const taggedModel: HermesModelOption = {
      description: "Local Ollama Qwen",
      modelId: "qwen2.5:7b-instruct",
      name: "Qwen 2.5 7B",
      providerId: "ollama",
      providerName: "Ollama",
      switchId: "ollama:qwen2.5:7b-instruct",
    };

    const { calls, client } = createMockClient({
      desiredModel: () => taggedModel,
    });

    await client.loadSessionHistory("sess-tagged");
    expect(calls[1].method).toBe("session/set_model");
    expect(calls[1].params.modelId).toBe("ollama:qwen2.5:7b-instruct");
    expect(client.currentSessionState.currentModel?.switchId).toBe("ollama:qwen2.5:7b-instruct");
  });

  it("does not deadlock: uses internal owned bounded RPC helper during load without claiming model session operation", async () => {
    const targetModel = modelOption("provider:test-model");
    const { client } = createMockClient({
      desiredModel: () => targetModel,
    });

    await expect(client.loadSessionHistory("sess-no-deadlock")).resolves.toBeDefined();
    expect(client.isOperating).toBe(false);
  });

  it("prevents EVERY normal session/prompt when restoration returns null (rejected by backend)", async () => {
    const targetModel = modelOption("rejected:model-fail");
    const { calls, client, events } = createMockClient({
      desiredModel: () => targetModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          return null;
        }
        return undefined;
      },
    });

    await expect(client.loadSessionHistory("sess-reject")).rejects.toThrow(
      /Hermes rejected model restoration to ".*" \(rejected:model-fail\)/,
    );

    expect(client.sessionId).toBe("sess-reject");
    expect(client.isConnected).toBe(true);

    expect(
      events.some(
        (e) =>
          e.type === "error" &&
          e.message.includes("Please select another model in the model picker"),
      ),
    ).toBe(true);

    await expect(client.sendPrompt("blocked prompt")).rejects.toMatchObject({
      message: expect.stringContaining("Please select another model in the model picker"),
      promptNotDispatched: true,
    });

    expect(calls.some((c) => c.method === "session/prompt")).toBe(false);
  });

  it("prevents EVERY normal session/prompt or activeSession.prompt when restoration times out", async () => {
    vi.useFakeTimers();
    try {
      const targetModel = modelOption("slow:model-timeout");
      const { calls, client } = createMockClient({
        desiredModel: () => targetModel,
        requestHandler: async (method) => {
          if (method === "session/set_model") {
            return new Promise(() => {});
          }
          return undefined;
        },
      });

      const loading = client.loadSessionHistory("sess-timeout");
      const failure = expect(loading).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_001);
      await failure;

      const sending = client.sendPrompt("blocked prompt");
      await expect(sending).rejects.toMatchObject({
        promptNotDispatched: true,
      });

      expect(calls.some((c) => c.method === "session/prompt")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows explicit recovery via model picker to another provider after restoration failure", async () => {
    let rejectSetModel = true;
    const failingModel = modelOption("fail-prov:fail-model", "Failing Model", "fail-prov");
    const workingModel = modelOption("anthropic:claude-3-5", "Claude 3.5", "anthropic");

    const { calls, client } = createMockClient({
      desiredModel: () => failingModel,
      requestHandler: async (method, params) => {
        if (method === "session/set_model") {
          if (rejectSetModel && params.modelId === "fail-prov:fail-model") {
            return null;
          }
          return {};
        }
        return undefined;
      },
    });

    await expect(client.loadSessionHistory("sess-recover")).rejects.toThrow(
      /Hermes rejected model restoration/,
    );
    expect(client.sessionId).toBe("sess-recover");

    await expect(client.sendPrompt("will fail")).rejects.toMatchObject({
      promptNotDispatched: true,
    });

    rejectSetModel = false;
    await client.setModel(workingModel);

    expect(client.currentSessionState.currentModel).toEqual(workingModel);

    await client.sendPrompt("now working prompt");
    expect(calls.some((c) => c.method === "session/prompt")).toBe(true);
  });

  it("deriveConversationControlAvailability keeps model picker enabled when connection === 'failed' with session", () => {
    const failedWithSession = {
      activeTabId: "tab-1",
      globalOperation: "idle" as const,
      initializing: false,
      tabs: new Map([
        [
          "tab-1",
          {
            closing: false,
            connection: "failed" as const,
            hasSession: true,
            permissionPending: false,
            prompt: "idle" as const,
            sessionOperation: "idle" as const,
          },
        ],
      ]),
    };

    const controls = deriveConversationControlAvailability(failedWithSession, "tab-1");
    expect(controls.send).toBe(false);
    expect(controls.model).toBe(true);
  });

  it("two tabs with SAME model name but DIFFERENT providers/switch IDs never leak or inherit", async () => {
    const googleGemini: HermesModelOption = {
      description: "Direct Google Gemini API",
      modelId: "gemini-1.5-pro",
      name: "Gemini 1.5 Pro",
      providerId: "google",
      providerName: "Google",
      switchId: "google:gemini-1.5-pro",
    };

    const openrouterGemini: HermesModelOption = {
      description: "Gemini 1.5 Pro via OpenRouter",
      modelId: "gemini-1.5-pro",
      name: "Gemini 1.5 Pro",
      providerId: "openrouter",
      providerName: "OpenRouter",
      switchId: "openrouter:google/gemini-1.5-pro",
    };

    const { calls: calls1, client: client1 } = createMockClient({
      desiredModel: () => googleGemini,
    });

    const { calls: calls2, client: client2 } = createMockClient({
      desiredModel: () => openrouterGemini,
    });

    await client1.loadSessionHistory("sess-tab-1");
    await client2.loadSessionHistory("sess-tab-2");

    expect(calls1.find((c) => c.method === "session/set_model")?.params).toEqual({
      modelId: "google:gemini-1.5-pro",
      sessionId: "sess-tab-1",
    });

    expect(calls2.find((c) => c.method === "session/set_model")?.params).toEqual({
      modelId: "openrouter:google/gemini-1.5-pro",
      sessionId: "sess-tab-2",
    });

    expect(client1.currentSessionState.currentModel?.switchId).toBe("google:gemini-1.5-pro");
    expect(client2.currentSessionState.currentModel?.switchId).toBe("openrouter:google/gemini-1.5-pro");
  });

  it("cancel during restoration prevents prompt dispatch and releases prompt slot", async () => {
    const restorationGate = deferred<Record<string, never>>();
    const targetModel = modelOption("custom:gate:model");
    const { calls, client } = createMockClient({
      desiredModel: () => targetModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          return restorationGate.promise;
        }
        return undefined;
      },
      resumedSessionId: "sess-cancel",
    });

    const sending = client.sendPrompt("cancel me");
    const rejected = expect(sending).rejects.toThrow("Hermes prompt was cancelled before dispatch");

    for (let i = 0; i < 5; i++) await Promise.resolve();
    await client.cancel();

    restorationGate.resolve({});
    await rejected;

    expect(calls.some((c) => c.method === "session/prompt")).toBe(false);
    expect(client.isBusy).toBe(false);
  });

  it("late old lifecycle ack does not mutate or dispatch into new session", async () => {
    const oldSetModel = deferred<Record<string, never>>();
    const targetModel = modelOption("prov:first-model");

    const { client } = createMockClient({
      desiredModel: (sessionId) => (sessionId === "sess-1" ? targetModel : undefined),
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          return oldSetModel.promise;
        }
        return undefined;
      },
    });

    const load1 = client.loadSessionHistory("sess-1");
    for (let i = 0; i < 5; i++) await Promise.resolve();

    await client.disconnect();

    oldSetModel.resolve({});
    await expect(load1).rejects.toThrow(/cancelled|stale/);

    expect(client.currentSessionState.currentModel).toBeUndefined();
  });

  it("late old lifecycle ack on same connection does not mutate new session after session changed", async () => {
    const oldSetModel = deferred<Record<string, never>>();
    const targetModel = modelOption("prov:first-model");

    const { client } = createMockClient({
      desiredModel: (sessionId) => (sessionId === "sess-1" ? targetModel : undefined),
      requestHandler: async (method, params) => {
        if (method === "session/set_model" && params.sessionId === "sess-1") {
          return oldSetModel.promise;
        }
        return undefined;
      },
    });

    // sess-1 starts restoration
    const load1 = client.loadSessionHistory("sess-1");
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Now switch session to sess-2 manually
    Reflect.set(client, "resumedSessionId", "sess-2");

    // Old set_model resolves
    oldSetModel.resolve({});
    await expect(load1).rejects.toThrow("Hermes session changed during model restoration");
  });

  it("deferred catalog resolution NEVER reverts confirmed restored selection", async () => {
    const gate = deferred<any>();
    catalogPromise = gate.promise;

    const restoredModel = modelOption("custom:future-grok:grok-2", "Grok 2", "custom:future-grok");
    const { client } = createMockClient({
      desiredModel: () => restoredModel,
    });

    // 1. loadSessionHistory completes restoration
    await client.loadSessionHistory("sess-catalog-race");
    expect(client.currentSessionState.currentModel?.switchId).toBe("custom:future-grok:grok-2");

    // 2. Late catalog resolves with generic custom provider and custom:gemini model
    gate.resolve({
      currentProviderId: "custom",
      models: [
        {
          description: "Custom Gemini",
          modelId: "gemini",
          name: "Gemini",
          providerId: "custom",
          providerName: "Custom",
          switchId: "custom:gemini",
        },
      ],
      providers: [
        {
          id: "custom",
          label: "Custom Provider",
          models: [
            {
              description: "Custom Gemini",
              modelId: "gemini",
              name: "Gemini",
              providerId: "custom",
              providerName: "Custom",
              switchId: "custom:gemini",
            },
          ],
        },
      ],
    });

    // Let catalog microtasks settle
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // currentModel must NOT have reverted to custom:gemini!
    expect(client.currentSessionState.currentModel?.switchId).toBe("custom:future-grok:grok-2");
    expect(client.currentSessionState.catalogLoading).toBe(false);
  });

  it("deferred catalog resolution race while restoration is in flight retains desired model", async () => {
    const catalogGate = deferred<any>();
    catalogPromise = catalogGate.promise;

    const setModelGate = deferred<Record<string, never>>();
    const restoredModel = modelOption("custom:future-grok:grok-2", "Grok 2", "custom:future-grok");

    const { client } = createMockClient({
      desiredModel: () => restoredModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          return setModelGate.promise;
        }
        return undefined;
      },
    });

    // Start loadSessionHistory: set_model will be in flight
    const loading = client.loadSessionHistory("sess-catalog-in-flight");
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Catalog resolves WHILE restoration is still in flight!
    catalogGate.resolve({
      currentProviderId: "custom",
      models: [
        {
          description: "Custom Gemini",
          modelId: "gemini",
          name: "Gemini",
          providerId: "custom",
          providerName: "Custom",
          switchId: "custom:gemini",
        },
      ],
      providers: [
        {
          id: "custom",
          label: "Custom Provider",
          models: [
            {
              description: "Custom Gemini",
              modelId: "gemini",
              name: "Gemini",
              providerId: "custom",
              providerName: "Custom",
              switchId: "custom:gemini",
            },
          ],
        },
      ],
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Now set_model finishes
    setModelGate.resolve({});
    await loading;

    expect(client.currentSessionState.currentModel?.switchId).toBe("custom:future-grok:grok-2");
  });

  it("honors tab selection on fresh session connect and prevents activeSession.prompt on failure", async () => {
    const chosenModel = modelOption("openai:gpt-4o", "GPT-4o", "openai");
    let setModelSucceeds = false;

    const { client, freshPrompt } = createMockClient({
      desiredModel: () => chosenModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          if (!setModelSucceeds) {
            return null; // rejected on first attempt
          }
          return {};
        }
        return undefined;
      },
    });

    // Configure client to simulate fresh connect without spawning subprocess
    Reflect.set(client, "connectPromise", undefined);
    Reflect.set(client, "ensureTransport", vi.fn(async () => {}));

    // connect() calls startFreshSession() which calls restoreModelRoute
    await expect(client.connect()).rejects.toThrow(/Hermes rejected model restoration/);

    // Session binding was retained on activeSession
    expect(client.sessionId).toBe("fresh-session-xyz");

    // Calling activeSession.prompt directly throws and prevents dispatch
    expect(() => (client as any).activeSession.prompt("direct prompt")).toThrow(
      /Hermes rejected model restoration/,
    );
    expect(freshPrompt).not.toHaveBeenCalled();

    // Calling sendPrompt throws with promptNotDispatched
    await expect(client.sendPrompt("prompt that must not send")).rejects.toMatchObject({
      promptNotDispatched: true,
    });
    expect(freshPrompt).not.toHaveBeenCalled();

    // Recovery: user picks working model
    setModelSucceeds = true;
    const recoveryModel = modelOption("anthropic:claude-3-5", "Claude 3.5", "anthropic");
    await client.setModel(recoveryModel);

    // Now prompt succeeds
    await client.sendPrompt("now working fresh prompt");
    expect(freshPrompt).toHaveBeenCalledOnce();
  });

  it("honors tab selection on newSession (restart) lifecycle", async () => {
    const chosenModel = modelOption("google:gemini-pro", "Gemini Pro", "google");
    const { client, calls } = createMockClient({
      desiredModel: () => chosenModel,
    });

    await client.newSession();

    const setModelCall = calls.find((c) => c.method === "session/set_model");
    expect(setModelCall).toBeDefined();
    expect(setModelCall?.params).toEqual({
      modelId: "google:gemini-pro",
      sessionId: "fresh-session-xyz",
    });
    expect(client.currentSessionState.currentModel?.switchId).toBe("google:gemini-pro");
  });

  it("avoid reapplying saved selection from an old tab session to a newly opened history session", async () => {
    let currentWs: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 2,
      tabs: [
        {
          draft: "draft",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          selectedModel: modelOption("old-prov:old-model"),
          sessionId: "sess-1",
        },
      ],
      version: 2,
    };

    const mockClient = {
      loadSessionHistory: vi.fn(async () => []),
      sessionId: "history-session-99",
    };

    const controller = new ConversationController({
      clients: {
        acquireClient: () => mockClient as any,
        getClient: () => mockClient as any,
        isCurrentClient: () => true,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => currentWs,
        setWorkspace: (next) => {
          currentWs = next;
        },
      },
    });

    await controller.bindHistorySession("tab-1", "history-session-99");

    const tab = currentWs.tabs.find((t) => t.id === "tab-1")!;
    expect(tab.sessionId).toBe("history-session-99");
    expect(tab.selectedModel).toBeUndefined();
  });

  it("controller.setSelectedModel transitions tab operation from 'failed' to 'ready'", async () => {
    let currentWs = createConversationWorkspace("tab-1", "sess-1");
    currentWs = updateConversationTab(currentWs, "tab-1", {
      selectedModel: modelOption("failing:model"),
    });

    const controller = new ConversationController({
      clients: {
        acquireClient: () => ({} as any),
        getClient: () => undefined,
        isCurrentClient: () => false,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => currentWs,
        setWorkspace: (next) => {
          currentWs = next;
        },
      },
    });

    Reflect.set(controller, "snapshot", {
      ...(Reflect.get(controller, "snapshot") as any),
      tabOperations: new Map([
        [
          "tab-1",
          {
            closing: false,
            connection: "failed",
            hasSession: true,
            permissionPending: false,
            prompt: "idle",
            sessionOperation: "idle",
          },
        ],
      ]),
      workspace: currentWs,
    });

    const newWorkingModel = modelOption("working:model-claude");
    await controller.setSelectedModel("tab-1", newWorkingModel, "sess-1");

    const tabOp = controller.getSnapshot().tabOperations.get("tab-1");
    expect(tabOp?.connection).toBe("ready");
    expect(tabOp?.hasSession).toBe(true);
    expect(controller.getSelectedModel("tab-1")).toEqual(newWorkingModel);
  });

  it("startup round-trip: controller restores persisted selectedModel via session/set_model BEFORE tab is ready, legacy tab sends no set_model and remains ready", async () => {
    const customPersistedModel = modelOption("custom:future-grok:grok-2", "Grok 2", "custom:future-grok");

    let persistedWorkspace: PersistedConversationWorkspace = {
      activeTabId: "tab-persisted",
      nextLabel: 3,
      tabs: [
        {
          draft: "",
          id: "tab-persisted",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          selectedModel: customPersistedModel,
          sessionId: "sess-persisted",
        },
        {
          draft: "",
          id: "tab-legacy",
          includeCurrentDocumentContext: true,
          label: 2,
          reasoningEffort: "default",
          sessionId: "sess-legacy",
        },
      ],
      version: 2,
    };

    let tabPersistedConnectionWhenSetModelCalled: string | undefined;

    const mockPersisted = createMockClient({
      desiredModel: (sessionId) => (sessionId === "sess-persisted" ? customPersistedModel : undefined),
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          tabPersistedConnectionWhenSetModelCalled =
            controller.getSnapshot().tabOperations.get("tab-persisted")?.connection;
        }
        return undefined;
      },
      resumedSessionId: "sess-persisted",
    });

    const mockLegacy = createMockClient({
      desiredModel: () => undefined,
      resumedSessionId: "sess-legacy",
    });

    const clients = new Map([
      ["tab-persisted", mockPersisted.client],
      ["tab-legacy", mockLegacy.client],
    ]);

    const controller = new ConversationController({
      clients: {
        acquireClient: (tabId: string) => clients.get(tabId)!,
        getClient: (tabId: string) => clients.get(tabId),
        isCurrentClient: (tabId: string, candidate: any) => clients.get(tabId) === candidate,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => persistedWorkspace,
        setWorkspace: async (next) => {
          persistedWorkspace = next;
        },
      },
    });

    // Initial state: both tabs are unloaded
    expect(controller.getSnapshot().tabOperations.get("tab-persisted")?.connection).toBe("unloaded");
    expect(controller.getSnapshot().tabOperations.get("tab-legacy")?.connection).toBe("unloaded");

    // Initialize controller (hydrates active tab and queues background tab)
    await controller.initialize();
    await controller.ensureConversationReady("tab-legacy");

    // Assert tab-persisted: exact RPC calls and transitions
    expect(mockPersisted.calls.map((c) => c.method)).toEqual(["session/load", "session/set_model"]);
    expect(mockPersisted.calls[0].params.sessionId).toBe("sess-persisted");
    expect(mockPersisted.calls[1].params).toEqual({
      modelId: "custom:future-grok:grok-2",
      sessionId: "sess-persisted",
    });

    // set_model was executed while connection state was "loading" (BEFORE becoming "ready" and before any send)
    expect(tabPersistedConnectionWhenSetModelCalled).toBe("loading");
    expect(controller.getSnapshot().tabOperations.get("tab-persisted")?.connection).toBe("ready");
    expect(mockPersisted.client.currentSessionState.currentModel?.switchId).toBe("custom:future-grok:grok-2");

    // Assert tab-legacy: exact RPC calls and transitions
    expect(mockLegacy.calls.map((c) => c.method)).toEqual(["session/load"]);
    expect(mockLegacy.calls[0].params.sessionId).toBe("sess-legacy");
    expect(mockLegacy.calls.some((c) => c.method === "session/set_model")).toBe(false);
    expect(controller.getSnapshot().tabOperations.get("tab-legacy")?.connection).toBe("ready");
    expect(mockLegacy.client.currentSessionState.currentModel?.switchId).not.toBe("custom:future-grok:grok-2");
  });

  it("(a) disconnect while restore RPC is in flight: late rejection must NOT leave modelRestorationFailure, and a subsequent connect/send on a NEW session with no desired model dispatches normally", async () => {
    const setModelGate = deferred<Record<string, never>>();
    const desiredModel = modelOption("prov:restore-model");
    let activeDesiredModel: HermesModelOption | undefined = desiredModel;

    const { calls, client, freshPrompt, freshSession, request } = createMockClient({
      desiredModel: () => activeDesiredModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          return setModelGate.promise;
        }
        return undefined;
      },
    });

    // Start loadSessionHistory: session/set_model is now in flight
    const loadPromise = client.loadSessionHistory("sess-disconnect");
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Disconnect while restore RPC is in flight
    await client.disconnect();

    // Now late rejection arrives from ACP / transport
    setModelGate.reject(new Error("Connection reset by peer"));
    await expect(loadPromise).rejects.toThrow();

    // Verify modelRestorationFailure was NOT left recorded on the client
    expect(Reflect.get(client, "modelRestorationFailure")).toBeUndefined();

    // Subsequent connect and send on a NEW session with no desired model
    activeDesiredModel = undefined;
    Reflect.set(client, "connectPromise", undefined);
    Reflect.set(client, "connection", {
      close: vi.fn(),
      signal: { aborted: false },
    });
    Reflect.set(client, "context", {
      buildSession: () => ({
        start: async () => freshSession,
      }),
      request,
    });
    Reflect.set(client, "intentionalShutdown", false);
    Reflect.set(client, "ensureTransport", vi.fn(async () => {}));

    await client.connect();
    await client.sendPrompt("new session prompt");

    expect(freshPrompt).toHaveBeenCalledOnce();
    const promptCalls = calls.filter((c) => c.method === "session/prompt");
    expect(promptCalls).toHaveLength(0); // called via freshSession.prompt
  });

  it("(b) cancelled prompt during restore never records a model failure and a later send still works", async () => {
    const setModelGate = deferred<Record<string, never>>();
    const desiredModel = modelOption("prov:cancel-model");
    let failSetModel = true;

    const { calls, client } = createMockClient({
      desiredModel: () => desiredModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          if (failSetModel) {
            return setModelGate.promise;
          }
          return {};
        }
        return undefined;
      },
      resumedSessionId: "sess-cancel-test",
    });

    // Send first prompt: restoreModelRoute is invoked
    const prompt1 = client.sendPrompt("prompt 1");
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Cancel the prompt while restore is in flight
    await client.cancel();

    // Reject the in-flight restore RPC with a cancellation error
    setModelGate.reject(new Error("Hermes ACP operation was cancelled"));
    await expect(prompt1).rejects.toThrow(/cancelled/);

    // modelRestorationFailure must NOT be recorded
    expect(Reflect.get(client, "modelRestorationFailure")).toBeUndefined();

    // A later send on the same session still works
    failSetModel = false;
    await client.sendPrompt("prompt 2");

    expect(Reflect.get(client, "modelRestorationFailure")).toBeUndefined();
    expect(client.currentSessionState.currentModel?.switchId).toBe("prov:cancel-model");
    const promptCalls = calls.filter((c) => c.method === "session/prompt");
    expect(promptCalls).toHaveLength(1);
  });

  it("(c) fresh connect after a prior genuine failure on a tab WITHOUT selectedModel proceeds with backend default and dispatches", async () => {
    let activeDesiredModel: HermesModelOption | undefined = modelOption("fail:model", "Failing Model");

    const { client, freshPrompt } = createMockClient({
      desiredModel: () => activeDesiredModel,
      requestHandler: async (method) => {
        if (method === "session/set_model") {
          return null; // genuine rejection
        }
        return undefined;
      },
    });

    // Simulate fresh connect without spawning subprocess
    Reflect.set(client, "connectPromise", undefined);
    Reflect.set(client, "ensureTransport", vi.fn(async () => {}));

    // First connect fails genuinely
    await expect(client.connect()).rejects.toThrow(/Hermes rejected model restoration/);
    expect(Reflect.get(client, "modelRestorationFailure")).toBeDefined();

    // Now tab has NO selectedModel (activeDesiredModel is undefined)
    activeDesiredModel = undefined;
    Reflect.set(client, "connectPromise", undefined);
    Reflect.set(client, "activeSession", undefined);

    // Fresh connect for the tab without selectedModel
    await client.connect();

    // Stale failure must be cleared at entry, and prompt dispatches normally with backend default
    expect(Reflect.get(client, "modelRestorationFailure")).toBeUndefined();
    await client.sendPrompt("prompt without model override");
    expect(freshPrompt).toHaveBeenCalledOnce();
  });
});
