import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real-execution persistence tests for hidden model switch ids.
 *
 * These instantiate the actual production plugin class and drive its real
 * save/load entry points against a controllable saveData/loadData stand-in:
 * a save writes through `savePluginSettings` -> `saveData`, and a simulated
 * restart loads that same payload through the production `loadSettings` path.
 */

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  saveImpl: undefined as ((data: unknown) => Promise<void>) | undefined,
  notices: [] as string[],
}));

vi.mock("obsidian", () => ({
  addIcon: () => {},
  App: class {},
  FileSystemAdapter: class {},
  MarkdownFileInfo: class {},
  MarkdownView: class {},
  Notice: class {
    constructor(message: string) {
      state.notices.push(message);
    }
  },
  Plugin: class {
    app: unknown;
    manifest: unknown;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
    async loadData(): Promise<unknown> {
      return state.data;
    }
    async saveData(data: unknown): Promise<void> {
      if (state.saveImpl) {
        await state.saveImpl(data);
        return;
      }
      state.data = data;
    }
  },
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  WorkspaceLeaf: class {},
  ItemView: class {},
  MarkdownRenderer: class {},
  setIcon: () => {},
}));

import HermesianPlugin from "../src/main";
import { ConversationController } from "../src/conversation-controller";
import type { PersistedConversationWorkspace } from "../src/conversation-tabs";
import type { HermesModelOption } from "../src/types";
import { HermesianSidebarView } from "../src/view";
import { FileSystemAdapter } from "obsidian";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createPlugin(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new HermesianPlugin({} as any, { id: "hermesian" } as any) as any;
}

async function loadPlugin(plugin: unknown): Promise<void> {
  await (plugin as { loadSettings(): Promise<void> }).loadSettings();
}

beforeEach(() => {
  state.data = undefined;
  state.saveImpl = undefined;
  state.notices = [];
});

afterEach(() => {
  state.saveImpl = undefined;
});

describe("hidden model persistence (real execution)", () => {
  it("single save writes normalized data through the production saveData path", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds([" a ", "b", "a", "", "  "]);
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "a",
      "b",
    ]);
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
  });

  it("a fresh instance restores the persisted list through the production load path", async () => {
    const first = createPlugin();
    await loadPlugin(first);
    await first.saveHiddenModelSwitchIds(["openai:gpt-4o", "deepseek:r1"]);
    // simulated restart: brand-new plugin instance loads the same payload
    const second = createPlugin();
    await loadPlugin(second);
    expect(second.settings.hiddenModelSwitchIds).toEqual(["openai:gpt-4o", "deepseek:r1"]);
  });

  it("failed save rolls memory back, propagates the error and shows a Notice", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    state.saveImpl = async () => {
      throw new Error("disk full");
    };
    await expect(plugin.saveHiddenModelSwitchIds(["x"])).rejects.toThrow("disk full");
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["base"]);
    expect(
      state.notices.some((notice) => notice.includes("could not save hidden models")),
    ).toBe(true);
    // disk untouched
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "base",
    ]);
  });

  it("a stale failure never overwrites a newer success at the plugin entry point", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const writes: string[][] = [];
    state.saveImpl = async (data) => {
      writes.push((data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds);
      if (writes.length === 1) {
        await firstGate; // hold the first write in flight
        throw new Error("late failure"); // ...then it fails late
      }
      state.data = data; // second (newer) write succeeds
    };
    const first = plugin.saveHiddenModelSwitchIds(["a"]);
    await tick(); // first write is now in flight
    const second = plugin.saveHiddenModelSwitchIds(["a", "b"]);
    releaseFirst();
    await first; // stale failure resolves silently (newer request exists)
    await second;
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
    expect(writes[writes.length - 1]).toEqual(["a", "b"]);
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "a",
      "b",
    ]);
    expect(state.notices).toHaveLength(0); // stale failure is not reported
  });

  it("a stale success is followed by a re-persist of the newest candidate", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const writes: string[][] = [];
    state.saveImpl = async (data) => {
      writes.push((data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds);
      if (writes.length === 1) {
        await firstGate; // first write completes late, after B was queued
      }
      state.data = data;
    };
    const first = plugin.saveHiddenModelSwitchIds(["a"]);
    await tick();
    const second = plugin.saveHiddenModelSwitchIds(["a", "b"]);
    releaseFirst();
    await first;
    await second;
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(["a", "b"]);
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "a",
      "b",
    ]);
  });

  it("three synchronous requests: the newest failure rejects, rolls back to the last success and survives restart", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    const calls: string[][] = [];
    state.saveImpl = async (data) => {
      const ids = (data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds;
      calls.push(ids);
      if (ids.join(",") === "a" || ids.join(",") === "a,b") {
        state.data = data; // A and B really update the store
      } else {
        throw new Error("c fails"); // C fails
      }
    };
    const a = plugin.saveHiddenModelSwitchIds(["a"]);
    const b = plugin.saveHiddenModelSwitchIds(["a", "b"]);
    const c = plugin.saveHiddenModelSwitchIds(["a", "b", "c"]);
    await a;
    await b;
    await expect(c).rejects.toThrow("c fails");
    expect(calls).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
    expect(
      state.notices.filter((notice) => notice.includes("could not save hidden models")),
    ).toHaveLength(1);
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
    // simulated restart: the disk state (B) is what a fresh instance loads
    const second = createPlugin();
    await loadPlugin(second);
    expect(second.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
  });
});

describe("per-tab model selection persistence and user save path (real execution)", () => {
  it("restores two tabs with SAME Gemini model name but DIFFERENT provider/switch IDs across real saveData/loadData round-trip", async () => {
    const first = createPlugin();
    await loadPlugin(first);

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

    const workspace: PersistedConversationWorkspace = {
      activeTabId: "tab-google",
      nextLabel: 3,
      tabs: [
        {
          draft: "draft google",
          id: "tab-google",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          sessionId: "sess-google",
          selectedModel: googleGemini,
        },
        {
          draft: "draft openrouter",
          id: "tab-openrouter",
          includeCurrentDocumentContext: true,
          label: 2,
          reasoningEffort: "high",
          sessionId: "sess-openrouter",
          selectedModel: openrouterGemini,
        },
      ],
      version: 2,
    };

    await first.flushConversationWorkspace(workspace);

    // Verify raw persisted payload in state.data
    const saved = state.data as { conversationWorkspace: PersistedConversationWorkspace };
    expect(saved.conversationWorkspace.tabs[0].selectedModel).toEqual(googleGemini);
    expect(saved.conversationWorkspace.tabs[1].selectedModel).toEqual(openrouterGemini);

    // Simulated restart: brand-new plugin instance loads same payload
    const second = createPlugin();
    await loadPlugin(second);

    const restoredWs = second.getConversationWorkspace();
    expect(restoredWs).toBeDefined();
    expect(restoredWs!.tabs).toHaveLength(2);

    const tab1 = restoredWs!.tabs.find((t: any) => t.id === "tab-google");
    const tab2 = restoredWs!.tabs.find((t: any) => t.id === "tab-openrouter");

    expect(tab1?.selectedModel).toEqual(googleGemini);
    expect(tab2?.selectedModel).toEqual(openrouterGemini);
    expect(tab1?.selectedModel?.name).toBe("Gemini 1.5 Pro");
    expect(tab2?.selectedModel?.name).toBe("Gemini 1.5 Pro");
    expect(tab1?.selectedModel?.providerId).toBe("google");
    expect(tab2?.selectedModel?.providerId).toBe("openrouter");
    expect(tab1?.selectedModel?.switchId).toBe("google:gemini-1.5-pro");
    expect(tab2?.selectedModel?.switchId).toBe("openrouter:google/gemini-1.5-pro");

    // S3 public seam: getSelectedModel
    expect(second.getSelectedModel("tab-google")).toEqual(googleGemini);
    expect(second.getSelectedModel("tab-openrouter")).toEqual(openrouterGemini);
  });

  it("serializes preference saves and rolls back only owned model field on save failure, preserving concurrent typing and thinking", async () => {
    let currentWs: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 3,
      tabs: [
        {
          draft: "original draft 1",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "high",
          sessionId: "sess-1",
          selectedModel: {
            description: "",
            modelId: "initial-model",
            name: "Initial Model",
            providerId: "initial-prov",
            providerName: "Initial Prov",
            switchId: "initial-prov:initial-model",
          },
        },
        {
          draft: "original draft 2",
          id: "tab-2",
          includeCurrentDocumentContext: true,
          label: 2,
          reasoningEffort: "low",
          sessionId: "sess-2",
        },
      ],
      version: 2,
    };

    let saveFail: ((err: Error) => void) | undefined;
    const gate = new Promise<void>((_, reject) => {
      saveFail = reject;
    });

    let persistFn: (() => Promise<void>) | undefined;
    const controller = new ConversationController({
      clients: {
        acquireClient: () => ({} as any),
        getClient: () => undefined,
        isCurrentClient: () => false,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => currentWs,
        setWorkspace: (next, options) => {
          currentWs = next;
          return options?.flush ? persistFn?.() : undefined;
        },
      },
    });

    const targetModel: HermesModelOption = {
      description: "",
      modelId: "new-model",
      name: "New Model",
      providerId: "new-prov",
      providerName: "New Prov",
      switchId: "new-prov:new-model",
    };

    // First save is held in flight
    persistFn = () => gate;
    const firstSave = controller.setSelectedModel("tab-1", targetModel, "sess-1");
    const failureExpectation = expect(firstSave).rejects.toThrow("disk failure");

    await Promise.resolve(); // wait for commit to begin

    // Concurrent typing occurs while persistence is awaiting
    currentWs = {
      ...currentWs,
      tabs: currentWs.tabs.map((tab) => ({
        ...tab,
        draft: tab.draft + " (concurrent typing)",
        reasoningEffort: "ultra",
      })),
    };

    // Release failure
    persistFn = undefined;
    saveFail!(new Error("disk failure"));

    await failureExpectation;

    // After failure:
    // tab-1 selectedModel rolled back to initial-model
    const tab1 = currentWs.tabs.find((t) => t.id === "tab-1")!;
    expect(tab1.selectedModel?.switchId).toBe("initial-prov:initial-model");
    // concurrent typing and reasoning effort were preserved!
    expect(tab1.draft).toBe("original draft 1 (concurrent typing)");
    expect(tab1.reasoningEffort).toBe("ultra");
    expect(currentWs.tabs.find((t) => t.id === "tab-2")!.draft).toBe("original draft 2 (concurrent typing)");
  });

  it("failed switch on client does not persist or overwrite saved selection, and surfaces Notice", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);

    const initialModel: HermesModelOption = {
      description: "",
      modelId: "gpt-4o",
      name: "GPT-4o",
      providerId: "openai",
      providerName: "OpenAI",
      switchId: "openai:gpt-4o",
    };

    const initialWs: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 2,
      tabs: [
        {
          draft: "draft",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          sessionId: "sess-1",
          selectedModel: initialModel,
        },
      ],
      version: 2,
    };
    await plugin.flushConversationWorkspace(initialWs);

    const mockClient = {
      sessionId: "sess-1",
      setModel: vi.fn(async () => {
        throw new Error("ACP connection dropped");
      }),
    };

    const view: any = {
      controller: {
        setSelectedModel: vi.fn(),
      },
      conversationWorkspace: initialWs,
      isTabBusy: () => false,
      messageFor: (err: unknown) => (err instanceof Error ? err.message : String(err)),
      plugin: {
        getClient: () => mockClient,
      },
      setConversationSelectedModel: vi.fn(),
    };

    const chooseModel = (HermesianSidebarView.prototype as any).chooseModel;
    await chooseModel.call(view, "tab-1", {
      description: "",
      modelId: "claude-3-5",
      name: "Claude 3.5",
      providerId: "anthropic",
      providerName: "Anthropic",
      switchId: "anthropic:claude-3-5",
    });

    expect(mockClient.setModel).toHaveBeenCalled();
    expect(view.setConversationSelectedModel).not.toHaveBeenCalled();
    expect(view.controller.setSelectedModel).not.toHaveBeenCalled();
    expect(
      state.notices.some((n) => n.includes("Hermesian model switch failed: ACP connection dropped")),
    ).toBe(true);
    expect(plugin.getSelectedModel("tab-1")).toEqual(initialModel);
  });

  it("save failure after successful client switch surfaces Notice and rolls back memory", async () => {
    const initialModel: HermesModelOption = {
      description: "",
      modelId: "gpt-4o",
      name: "GPT-4o",
      providerId: "openai",
      providerName: "OpenAI",
      switchId: "openai:gpt-4o",
    };

    let ws: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 2,
      tabs: [
        {
          draft: "draft",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          sessionId: "sess-1",
          selectedModel: initialModel,
        },
      ],
      version: 2,
    };

    const controller = new ConversationController({
      clients: {
        acquireClient: () => ({} as any),
        getClient: () => undefined,
        isCurrentClient: () => false,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => ws,
        setWorkspace: () => {
          throw new Error("EACCES: permission denied writing data.json");
        },
      },
    });

    const mockClient = {
      sessionId: "sess-1",
      setModel: vi.fn(async () => {}),
    };

    const view: any = {
      controller,
      conversationWorkspace: ws,
      isTabBusy: () => false,
      messageFor: (err: unknown) => (err instanceof Error ? err.message : String(err)),
      plugin: {
        getClient: () => mockClient,
      },
      async setConversationSelectedModel(tabId: string, model: any, expectedSessionId?: string | null) {
        await controller.setSelectedModel(tabId, model, expectedSessionId);
      },
    };

    const chooseModel = (HermesianSidebarView.prototype as any).chooseModel;
    await chooseModel.call(view, "tab-1", {
      description: "",
      modelId: "new-model",
      name: "New Model",
      providerId: "new-prov",
      providerName: "New Prov",
      switchId: "new-prov:new-model",
    });

    expect(mockClient.setModel).toHaveBeenCalled();
    expect(
      state.notices.some((n) =>
        n.includes("Hermesian model switch failed: EACCES: permission denied writing data.json"),
      ),
    ).toBe(true);

    expect(ws.tabs[0].selectedModel).toEqual(initialModel);
  });

  it("rejects and surfaces Notice when tab session changed while model switch was in flight", async () => {
    let ws: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 2,
      tabs: [
        {
          draft: "draft",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          sessionId: "sess-1",
        },
      ],
      version: 2,
    };

    const controller = new ConversationController({
      clients: {
        acquireClient: () => ({} as any),
        getClient: () => undefined,
        isCurrentClient: () => false,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => ws,
        setWorkspace: (next) => {
          ws = next;
        },
      },
    });

    const mockClient = {
      sessionId: "sess-1",
      setModel: vi.fn(async () => {
        // While setModel is in flight, session changes to sess-2!
        ws = {
          ...ws,
          tabs: [{ ...ws.tabs[0], sessionId: "sess-2" }],
        };
      }),
    };

    const view: any = {
      controller,
      conversationWorkspace: ws,
      isTabBusy: () => false,
      messageFor: (err: unknown) => (err instanceof Error ? err.message : String(err)),
      plugin: {
        getClient: () => mockClient,
      },
      async setConversationSelectedModel(tabId: string, model: any, expectedSessionId?: string | null) {
        await controller.setSelectedModel(tabId, model, expectedSessionId);
      },
    };

    const chooseModel = (HermesianSidebarView.prototype as any).chooseModel;
    await chooseModel.call(view, "tab-1", {
      description: "",
      modelId: "new-model",
      name: "New Model",
      providerId: "new-prov",
      providerName: "New Prov",
      switchId: "new-prov:new-model",
    });

    expect(
      state.notices.some((n) => n.includes("Hermesian model switch failed: Conversation session changed")),
    ).toBe(true);

    expect(ws.tabs[0].selectedModel).toBeUndefined();
  });

  it("rejects and surfaces Notice when tab was closed while model switch was in flight", async () => {
    let ws: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 3,
      tabs: [
        {
          draft: "draft",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          sessionId: "sess-1",
        },
        {
          draft: "draft 2",
          id: "tab-2",
          includeCurrentDocumentContext: true,
          label: 2,
          reasoningEffort: "default",
          sessionId: "sess-2",
        },
      ],
      version: 2,
    };

    const controller = new ConversationController({
      clients: {
        acquireClient: () => ({} as any),
        getClient: () => undefined,
        isCurrentClient: () => false,
        releaseClient: async () => {},
      },
      workspace: {
        getWorkspace: () => ws,
        setWorkspace: (next) => {
          ws = next;
        },
      },
    });

    const mockClient = {
      sessionId: "sess-1",
      setModel: vi.fn(async () => {
        // While setModel is in flight, tab-1 is closed!
        ws = {
          activeTabId: "tab-2",
          nextLabel: 3,
          tabs: [ws.tabs[1]],
          version: 2,
        };
      }),
    };

    const view: any = {
      controller,
      conversationWorkspace: ws,
      isTabBusy: () => false,
      messageFor: (err: unknown) => (err instanceof Error ? err.message : String(err)),
      plugin: {
        getClient: () => mockClient,
      },
      async setConversationSelectedModel(tabId: string, model: any, expectedSessionId?: string | null) {
        await controller.setSelectedModel(tabId, model, expectedSessionId);
      },
    };

    const chooseModel = (HermesianSidebarView.prototype as any).chooseModel;
    await chooseModel.call(view, "tab-1", {
      description: "",
      modelId: "new-model",
      name: "New Model",
      providerId: "new-prov",
      providerName: "New Prov",
      switchId: "new-prov:new-model",
    });

    expect(
      state.notices.some((n) =>
        n.includes("Hermesian model switch failed: Conversation is no longer available"),
      ),
    ).toBe(true);

    expect(ws.tabs.find((t) => t.id === "tab-1")).toBeUndefined();
  });

  it("simulates plugin restart from S2 saved payload: clients created by registry restore exact routes over RPC without leaking", async () => {
    const grokModel: HermesModelOption = {
      description: "Custom Future Grok",
      modelId: "grok-2",
      name: "Grok 2",
      providerId: "custom:future-grok",
      providerName: "Future Grok",
      switchId: "custom:future-grok:grok-2",
    };

    const qwenModel: HermesModelOption = {
      description: "Local Ollama Qwen",
      modelId: "qwen2.5:7b-instruct",
      name: "Qwen 2.5 7B",
      providerId: "ollama",
      providerName: "Ollama",
      switchId: "ollama:qwen2.5:7b-instruct",
    };

    const first = createPlugin();
    await loadPlugin(first);

    const workspace: PersistedConversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 3,
      tabs: [
        {
          draft: "draft 1",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          reasoningEffort: "default",
          sessionId: "sess-grok",
          selectedModel: grokModel,
        },
        {
          draft: "draft 2",
          id: "tab-2",
          includeCurrentDocumentContext: true,
          label: 2,
          reasoningEffort: "high",
          sessionId: "sess-qwen",
          selectedModel: qwenModel,
        },
      ],
      version: 2,
    };

    await first.flushConversationWorkspace(workspace);

    // Simulated plugin restart: brand new plugin instance
    const second = createPlugin();
    const adapter = new (FileSystemAdapter as any)();
    adapter.getBasePath = () => "/tmp/test-vault";
    second.app = { vault: { adapter } };
    await loadPlugin(second);

    // Clients obtained from plugin factory for tab-1 and tab-2
    const client1 = second.getClient("tab-1");
    const client2 = second.getClient("tab-2");

    // Desired model callbacks resolve correctly per-tab
    expect((client1 as any).options.desiredModel("sess-grok")).toEqual(grokModel);
    expect((client2 as any).options.desiredModel("sess-qwen")).toEqual(qwenModel);

    // Loading a different session on tab-1 does not leak tab-1's model
    expect((client1 as any).options.desiredModel("other-sess")).toBeUndefined();

    // Mock transport to verify outgoing RPCs on session restoration
    const calls1: any[] = [];
    Reflect.set(client1, "connectPromise", Promise.resolve());
    Reflect.set(client1, "connection", { close: vi.fn(), signal: { aborted: false } });
    Reflect.set(client1, "context", {
      request: vi.fn(async (method: string, params: any) => {
        calls1.push({ method, params });
        if (method === "session/load") {
          return { models: { currentModelId: "custom:gemini" } };
        }
        return {};
      }),
    });
    Reflect.set(client1, "intentionalShutdown", false);

    const calls2: any[] = [];
    Reflect.set(client2, "connectPromise", Promise.resolve());
    Reflect.set(client2, "connection", { close: vi.fn(), signal: { aborted: false } });
    Reflect.set(client2, "context", {
      request: vi.fn(async (method: string, params: any) => {
        calls2.push({ method, params });
        if (method === "session/load") {
          return { models: { currentModelId: "custom:gemini" } };
        }
        return {};
      }),
    });
    Reflect.set(client2, "intentionalShutdown", false);

    await client1.loadSessionHistory("sess-grok");
    await client2.loadSessionHistory("sess-qwen");

    // Client 1 restored exact Grok switchId
    expect(calls1[0].method).toBe("session/load");
    expect(calls1[1].method).toBe("session/set_model");
    expect(calls1[1].params).toEqual({
      modelId: "custom:future-grok:grok-2",
      sessionId: "sess-grok",
    });

    // Client 2 restored exact Qwen colon-tagged switchId
    expect(calls2[0].method).toBe("session/load");
    expect(calls2[1].method).toBe("session/set_model");
    expect(calls2[1].params).toEqual({
      modelId: "ollama:qwen2.5:7b-instruct",
      sessionId: "sess-qwen",
    });

    expect(client1.currentSessionState.currentModel).toEqual(grokModel);
    expect(client2.currentSessionState.currentModel).toEqual(qwenModel);
  });
});
