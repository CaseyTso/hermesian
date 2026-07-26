import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationController,
  type ConversationClient,
  type ConversationControllerDependencies,
} from "../src/conversation-controller";
import {
  addPendingConversationTab,
  createConversationWorkspace,
  replaceConversationSession,
  type PersistedConversationWorkspace,
} from "../src/conversation-tabs";
import type { HermesHistoryItem } from "../src/types";

interface FakeClient extends ConversationClient {
  id: string;
}

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

function fakeClient(id: string): FakeClient {
  return {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    id,
    loadSessionHistory: vi.fn(async () => []),
    newSession: vi.fn(async () => undefined),
    sessionId: `${id}-session`,
  };
}

function dependencies(
  workspace: ReturnType<typeof createConversationWorkspace> | undefined,
  client: FakeClient,
  clientsByTab?: Map<string, FakeClient>,
  createTabId: () => string = () => client.id,
): ConversationControllerDependencies<FakeClient> {
  const clients = clientsByTab ?? new Map([[client.id, client]]);
  let currentWorkspace = workspace;
  return {
    clients: {
      acquireClient: vi.fn((tabId: string) => clients.get(tabId) ?? client),
      getClient: vi.fn((tabId: string) => clients.get(tabId)),
      isCurrentClient: vi.fn((tabId: string, candidate: FakeClient) => clients.get(tabId) === candidate),
      releaseClient: vi.fn(async () => undefined),
    },
    workspace: {
      getWorkspace: vi.fn(() => currentWorkspace),
      setWorkspace: vi.fn((nextWorkspace) => {
        currentWorkspace = nextWorkspace;
      }),
    },
    createTabId,
  };
}

describe("ConversationController boundary", () => {
  it("reads the normalized workspace and seeds per-tab runtime state", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const controller = new ConversationController(
      dependencies(workspace, fakeClient("tab-a")),
    );

    const snapshot = controller.getSnapshot();

    expect(snapshot.workspace).toEqual(workspace);
    expect(snapshot.initializing).toBe(true);
    expect(snapshot.tabOperations.get("tab-a")).toMatchObject({
      connection: "unloaded",
      hasSession: true,
      prompt: "idle",
      sessionOperation: "idle",
    });
  });

  it("supports a workspace with a deferred tab without inventing a session", () => {
    const baseWorkspace = createConversationWorkspace("tab-a", "session-a");
    const workspace = {
      ...baseWorkspace,
      activeTabId: "tab-b",
      tabs: [
        ...baseWorkspace.tabs,
        {
          draft: "draft only",
          id: "tab-b",
          includeCurrentDocumentContext: true,
          label: 2,
          sessionId: null,
        },
      ],
      nextLabel: 3,
    };
    const controller = new ConversationController(
      dependencies(workspace, fakeClient("tab-b")),
    );

    expect(controller.getSnapshot().tabOperations.get("tab-b")).toMatchObject({
      connection: "deferred",
      hasSession: false,
    });
  });

  it("sends an immutable snapshot synchronously to subscribers", () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("tab-a", "session-a"), fakeClient("tab-a")),
    );
    const listener = vi.fn();

    const unsubscribe = controller.subscribe(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toBe(controller.getSnapshot());
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true);

    controller.setPermissionPending("tab-a", true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().tabOperations.get("tab-a")?.permissionPending).toBe(
      true,
    );

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    controller.setPermissionPending("tab-a", false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes active, per-tab, and aggregate controls in every snapshot", async () => {
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-b" };
    const controller = new ConversationController(
      dependencies(workspace, fakeClient("tab-b")),
    );

    await controller.initialize();
    controller.setPromptRunning("tab-a", true);
    const snapshot = controller.getSnapshot();

    expect(snapshot.controls.active).toBe(snapshot.controls.byTab.get("tab-b"));
    expect(snapshot.controls.byTab.get("tab-a")).toMatchObject({
      send: false,
      stop: true,
    });
    expect(snapshot.controls.byTab.get("tab-b")).toMatchObject({
      send: true,
      stop: false,
    });
    expect(snapshot.controls.aggregate).toMatchObject({
      connectionSettings: false,
      reasoning: false,
      tabNavigation: true,
    });
  });

  it("does not depend on Obsidian or DOM globals", () => {
    const source = readFileSync(
      new URL("../src/conversation-controller.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from ["']obsidian["']/);
    expect(source).not.toMatch(/\bHTMLElement\b/);
  });

  it("keeps control availability ownership out of View and Plugin", () => {
    const viewSource = readFileSync(
      new URL("../src/view.ts", import.meta.url),
      "utf8",
    );
    const pluginSource = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );

    expect(viewSource.includes("deriveConversationControlAvailability")).toBe(false);
    expect(viewSource.includes("conversationRuntimeState(")).toBe(false);
    expect(viewSource.includes("getSnapshot().controls")).toBe(true);
    expect(viewSource.includes("controlAvailability()")).toBe(true);
    expect(pluginSource.includes("hasBusyClient")).toBe(false);
    expect(pluginSource.includes("getAggregateConversationControls")).toBe(true);
    expect(pluginSource.includes("canApplyConnectionSettings")).toBe(true);
  });

  it("accepts fake clients whose protocol operations can be deferred", async () => {
    const connect = deferred<void>();
    const client = fakeClient("tab-a");
    client.connect = vi.fn(() => connect.promise);
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("tab-a", "session-a"), client),
    );

    expect(controller.getSnapshot().tabOperations.get("tab-a")?.connection).toBe("unloaded");
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe("ConversationController initialization", () => {
  it("creates and persists the first tab when no workspace exists", async () => {
    const client = fakeClient("tab-new");
    const deps = dependencies(undefined, client);
    const controller = new ConversationController(deps);

    const result = await controller.initialize();

    expect(deps.clients.acquireClient).toHaveBeenCalledWith("tab-new");
    expect(client.connect).toHaveBeenCalledOnce();
    expect(result.workspace.tabs).toHaveLength(1);
    expect(result.workspace.tabs[0]).toMatchObject({
      id: "tab-new",
      sessionId: "tab-new-session",
    });
    expect(deps.workspace.setWorkspace).toHaveBeenCalled();
    expect(controller.getSnapshot().initializing).toBe(false);
  });

  it("loads the saved active session before leaving initialization", async () => {
    const client = fakeClient("tab-a");
    const history: HermesHistoryItem[] = [{ kind: "user", text: "restored" }];
    client.loadSessionHistory = vi.fn(async (sessionId: string) => {
      client.sessionId = sessionId;
      return history;
    });
    const workspace = createConversationWorkspace("tab-a", "saved-session");
    const controller = new ConversationController(
      dependencies(workspace, client),
    );

    const result = await controller.initialize();

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.loadSessionHistory).toHaveBeenCalledWith("saved-session");
    expect(result.items).toEqual(history);
    expect(result.sessionId).toBe("saved-session");
    expect(result.tabId).toBe("tab-a");
    expect(controller.getSnapshot().initializing).toBe(false);
  });

  it("replaces a saved session only when the ACP load fails", async () => {
    const client = fakeClient("tab-a");
    client.loadSessionHistory = vi.fn(async () => {
      throw new Error("saved session unavailable");
    });
    client.newSession = vi.fn(async () => {
      client.sessionId = "replacement-session";
    });
    const workspace = createConversationWorkspace("tab-a", "saved-session");
    const controller = new ConversationController(
      dependencies(workspace, client),
    );

    const result = await controller.initialize();

    expect(client.loadSessionHistory).toHaveBeenCalledOnce();
    expect(client.newSession).toHaveBeenCalledOnce();
    expect(result.items).toBeUndefined();
    expect(result.started).toBe(true);
    expect(result.sessionId).toBe("replacement-session");
    expect(result.workspace.tabs[0]?.sessionId).toBe("replacement-session");
  });

  it("does not spawn clients for inactive tabs during startup", async () => {
    const first = fakeClient("tab-a");
    first.loadSessionHistory = vi.fn(async (sessionId: string) => {
      first.sessionId = sessionId;
      return [];
    });
    const second = fakeClient("tab-b");
    const base = createConversationWorkspace("tab-a", "session-a");
    const workspace = {
      ...base,
      tabs: [
        ...base.tabs,
        {
          draft: "",
          id: "tab-b",
          includeCurrentDocumentContext: true,
          label: 2,
          sessionId: "session-b",
        },
      ],
      nextLabel: 3,
    };
    const clients = new Map([
      ["tab-a", first],
      ["tab-b", second],
    ]);
    const deps = dependencies(workspace, first, clients);
    const controller = new ConversationController(deps);

    await controller.initialize();

    expect(deps.clients.acquireClient).toHaveBeenCalledWith("tab-a");
    expect(deps.clients.acquireClient).not.toHaveBeenCalledWith("tab-b");
    expect(second.connect).not.toHaveBeenCalled();

    const snapshot = controller.getSnapshot();
    expect(snapshot.tabOperations.get("tab-a")?.connection).toBe("ready");
    expect(snapshot.tabOperations.get("tab-b")?.connection).toBe("unloaded");
  });

  it("lazily hydrates an unloaded tab on first switch", async () => {
    const historyA = [{ kind: "user" as const, text: "A-restored" }];
    const historyB = [{ kind: "user" as const, text: "B-restored" }];

    const first = fakeClient("tab-a");
    first.loadSessionHistory = vi.fn(async (sessionId: string) => {
      first.sessionId = sessionId;
      return historyA;
    });
    const second = fakeClient("tab-b");
    second.loadSessionHistory = vi.fn(async (sessionId: string) => {
      second.sessionId = sessionId;
      return historyB;
    });

    const base = createConversationWorkspace("tab-a", "session-a");
    const workspace = {
      ...base,
      tabs: [
        ...base.tabs,
        {
          draft: "",
          id: "tab-b",
          includeCurrentDocumentContext: true,
          label: 2,
          sessionId: "session-b",
        },
      ],
      nextLabel: 3,
    };
    const clients = new Map([["tab-a", first], ["tab-b", second]]);
    const deps = dependencies(workspace, first, clients);
    const controller = new ConversationController(deps);

    await controller.initialize();

    // Only active tab A connected/loaded during startup
    expect(first.connect).toHaveBeenCalledOnce();
    expect(first.loadSessionHistory).toHaveBeenCalledWith("session-a");
    expect(second.connect).not.toHaveBeenCalled();

    // Switch to B — must hydrate lazily
    const result = await controller.switchConversation("tab-b");
    expect(second.connect).toHaveBeenCalledOnce();
    expect(second.loadSessionHistory).toHaveBeenCalledWith("session-b");
    expect(result.items).toEqual(historyB);
    expect(controller.getSnapshot().tabOperations.get("tab-b")?.connection).toBe("ready");

    // Switch back to A — no repeat load
    (first.loadSessionHistory as ReturnType<typeof vi.fn>).mockClear();
    await controller.switchConversation("tab-a");
    expect(first.loadSessionHistory).not.toHaveBeenCalled();
    expect(controller.getSnapshot().tabOperations.get("tab-a")?.connection).toBe("ready");
  });

  it("unloaded tab disallows send but permits close and tab navigation", async () => {
    const first = fakeClient("tab-a");
    const second = fakeClient("tab-b");
    const base = createConversationWorkspace("tab-a", "session-a");
    const workspace = {
      ...base,
      tabs: [
        ...base.tabs,
        {
          draft: "",
          id: "tab-b",
          includeCurrentDocumentContext: true,
          label: 2,
          sessionId: "session-b",
        },
      ],
      nextLabel: 3,
    };
    const clients = new Map([["tab-a", first], ["tab-b", second]]);
    const deps = dependencies(workspace, first, clients);
    const controller = new ConversationController(deps);
    await controller.initialize();

    const controlsB = controller.getSnapshot().controls.byTab.get("tab-b")!;
    expect(controlsB.send).toBe(false);
    expect(controlsB.close).toBe(true);
    expect(controlsB.activate).toBe(true);

    const aggregate = controller.getSnapshot().controls.aggregate;
    expect(aggregate.connectionSettings).toBe(true);
    expect(aggregate.tabNavigation).toBe(true);
  });

  it("drops a startup continuation after teardown without persisting it", async () => {
    const connect = deferred<void>();
    const client = fakeClient("tab-a");
    client.connect = vi.fn(() => connect.promise);
    const deps = dependencies(undefined, client);
    const controller = new ConversationController(deps);

    const initialization = controller.initialize();
    await Promise.resolve();
    const shutdown = controller.shutdown();
    connect.resolve();

    await expect(initialization).rejects.toMatchObject({ code: "cancelled" });
    await shutdown;
    expect(deps.workspace.setWorkspace).not.toHaveBeenCalled();
  });

  it("blocks session-mutating handlers while startup is pending", async () => {
    const connect = deferred<void>();
    const client = fakeClient("tab-a");
    client.connect = vi.fn(() => connect.promise);
    const controller = new ConversationController(
      dependencies(undefined, client),
    );

    const initialization = controller.initialize();
    await Promise.resolve();

    await expect(controller.addConversation()).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(controller.switchConversation("tab-a")).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(controller.restartConversation("tab-a")).rejects.toMatchObject({
      code: "cancelled",
    });
    connect.resolve();
    await initialization;
  });
});

describe("ConversationController add", () => {
  async function readyController(
    newClients: Map<string, FakeClient>,
    createTabId: () => string,
  ): Promise<{
    base: FakeClient;
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
  }> {
    const base = fakeClient("base");
    const workspace = createConversationWorkspace("base", "base-session");
    const deps = dependencies(
      workspace,
      base,
      new Map([["base", base], ...newClients]),
      createTabId,
    );
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { base, controller, deps };
  }

  it("creates a stable pending tab and marks it loading before connect resolves", async () => {
    const connect = deferred<void>();
    const added = fakeClient("new-tab");
    added.connect = vi.fn(() => connect.promise);
    const { controller } = await readyController(
      new Map([["new-tab", added]]),
      () => "new-tab",
    );

    const adding = controller.addConversation();
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace?.tabs.at(-1)).toMatchObject({
      id: "new-tab",
      sessionId: null,
    });
    expect(snapshot.workspace?.activeTabId).toBe("new-tab");
    expect(snapshot.tabOperations.get("new-tab")?.connection).toBe("loading");
    await Promise.resolve();
    expect(added.connect).toHaveBeenCalledOnce();

    connect.resolve();
    const result = await adding;
    expect(result).toMatchObject({ sessionId: "new-tab-session", tabId: "new-tab" });
    expect(controller.getSnapshot().tabOperations.get("new-tab")?.connection).toBe("ready");
  });

  it("keeps concurrent adds isolated and commits by stable tab ID", async () => {
    const firstConnect = deferred<void>();
    const secondConnect = deferred<void>();
    const first = fakeClient("new-one");
    const second = fakeClient("new-two");
    first.connect = vi.fn(() => firstConnect.promise);
    second.connect = vi.fn(() => secondConnect.promise);
    const ids = ["new-one", "new-two"];
    let nextId = 0;
    const { controller } = await readyController(
      new Map([
        ["new-one", first],
        ["new-two", second],
      ]),
      () => ids[nextId++]!,
    );

    const firstAdd = controller.addConversation();
    const secondAdd = controller.addConversation();
    expect(controller.getSnapshot().workspace?.tabs.map((tab) => tab.id)).toEqual([
      "base",
      "new-one",
      "new-two",
    ]);

    secondConnect.resolve();
    firstConnect.resolve();
    const [firstResult, secondResult] = await Promise.all([firstAdd, secondAdd]);
    expect(firstResult).toMatchObject({ sessionId: "new-one-session", tabId: "new-one" });
    expect(secondResult).toMatchObject({ sessionId: "new-two-session", tabId: "new-two" });
    expect(controller.getSnapshot().workspace?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "new-one", sessionId: "new-one-session" }),
        expect.objectContaining({ id: "new-two", sessionId: "new-two-session" }),
      ]),
    );
  });

  it("does not let an add continuation reclaim an active tab changed during connect", async () => {
    const connect = deferred<void>();
    const added = fakeClient("new-tab");
    added.connect = vi.fn(() => connect.promise);
    const { controller, deps } = await readyController(
      new Map([["new-tab", added]]),
      () => "new-tab",
    );

    const adding = controller.addConversation();
    const pending = deps.workspace.getWorkspace()!;
    deps.workspace.setWorkspace({ ...pending, activeTabId: "base" });
    connect.resolve();

    const result = await adding;
    expect(result.tabId).toBe("new-tab");
    expect(result.workspace.activeTabId).toBe("base");
  });

  it("keeps a failed pending tab visible and marks its connection failed", async () => {
    const added = fakeClient("new-tab");
    added.connect = vi.fn(async () => {
      throw new Error("connect failed");
    });
    const { controller } = await readyController(
      new Map([["new-tab", added]]),
      () => "new-tab",
    );

    await expect(controller.addConversation()).rejects.toThrow("connect failed");
    expect(controller.getSnapshot().workspace?.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "new-tab", sessionId: null })]),
    );
    expect(controller.getSnapshot().tabOperations.get("new-tab")?.connection).toBe("failed");
  });

  it("does not commit a session after a deferred tab was removed", async () => {
    const connect = deferred<void>();
    const added = fakeClient("new-tab");
    added.connect = vi.fn(() => connect.promise);
    const { controller, deps } = await readyController(
      new Map([["new-tab", added]]),
      () => "new-tab",
    );

    const adding = controller.addConversation();
    const pending = deps.workspace.getWorkspace()!;
    deps.workspace.setWorkspace({
      ...pending,
      activeTabId: "base",
      tabs: pending.tabs.filter((tab) => tab.id !== "new-tab"),
    });
    connect.resolve();

    await expect(adding).rejects.toMatchObject({ code: "workspace_conflict" });
    expect(deps.workspace.getWorkspace()?.tabs.some((tab) => tab.id === "new-tab")).toBe(false);
  });
});

describe("ConversationController switch", () => {
  async function readySwitchController(targetIds: string[]): Promise<{
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
    clients: Map<string, FakeClient>;
  }> {
    let workspace = createConversationWorkspace("base", "base-session");
    const clients = new Map<string, FakeClient>([["base", fakeClient("base")]]);
    for (const targetId of targetIds) {
      const target = fakeClient(targetId);
      clients.set(targetId, target);
      workspace = addPendingConversationTab(workspace, targetId);
      workspace = replaceConversationSession(workspace, targetId, `${targetId}-session`);
    }
    workspace = { ...workspace, activeTabId: "base" };
    const deps = dependencies(
      workspace,
      clients.get("base")!,
      clients,
    );
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { clients, controller, deps };
  }

  it("prepares history before committing the active tab", async () => {
    const history = deferred<HermesHistoryItem[]>();
    const { controller, deps, clients } = await readySwitchController(["tab-b"]);
    clients.get("tab-b")!.loadSessionHistory = vi.fn(() => history.promise);

    const switching = controller.switchConversation("tab-b");
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("base");
    history.resolve([]);

    const result = await switching;
    expect(result).toMatchObject({ tabId: "tab-b", sessionId: "tab-b-session" });
    expect(result.workspace.activeTabId).toBe("tab-b");
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-b");
  });

  it("does not reconnect or reload when switching to the active tab", async () => {
    const { controller, clients } = await readySwitchController(["tab-b"]);
    const result = await controller.switchConversation("base");

    expect(result).toMatchObject({ tabId: "base", sessionId: "base-session" });
    expect(clients.get("base")!.connect).toHaveBeenCalledOnce();
    expect(clients.get("base")!.loadSessionHistory).toHaveBeenCalledOnce();
  });

  it("keeps the previous active tab when target preparation fails", async () => {
    const { controller, deps, clients } = await readySwitchController(["tab-b"]);
    controller["snapshot"] = {
      ...controller.getSnapshot(),
      tabOperations: new Map(controller.getSnapshot().tabOperations).set(
        "tab-b",
        Object.freeze({
          closing: false,
          connection: "deferred" as const,
          hasSession: true,
          permissionPending: false,
          prompt: "idle" as const,
          sessionOperation: "idle" as const,
        }),
      ),
    };
    clients.get("tab-b")!.connect = vi.fn(async () => {
      throw new Error("connection unavailable");
    });

    await expect(controller.switchConversation("tab-b")).rejects.toThrow("connection unavailable");
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("base");
    expect(controller.getSnapshot().tabOperations.get("tab-b")?.connection).toBe("failed");
  });

  it("cancels an older switch when a newer switch wins", async () => {
    const firstHistory = deferred<HermesHistoryItem[]>();
    const secondHistory = deferred<HermesHistoryItem[]>();
    const { controller, deps, clients } = await readySwitchController(["tab-b", "tab-c"]);
    clients.get("tab-b")!.loadSessionHistory = vi.fn(() => firstHistory.promise);
    clients.get("tab-c")!.loadSessionHistory = vi.fn(() => secondHistory.promise);

    const firstSwitch = controller.switchConversation("tab-b");
    const secondSwitch = controller.switchConversation("tab-c");
    secondHistory.resolve([]);
    const secondResult = await secondSwitch;
    expect(secondResult.workspace.activeTabId).toBe("tab-c");

    firstHistory.resolve([]);
    await expect(firstSwitch).rejects.toMatchObject({ code: "cancelled" });
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
  });

  it("rejects a switch to a missing tab without mutating workspace", async () => {
    const { controller, deps } = await readySwitchController([]);

    await expect(controller.switchConversation("missing")).rejects.toMatchObject({
      code: "workspace_conflict",
      tabId: "missing",
    });
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("base");
  });
});

describe("ConversationController close", () => {
  async function readyCloseController(
    workspace: ReturnType<typeof createConversationWorkspace>,
    clients: Map<string, FakeClient>,
    createTabId?: () => string,
  ): Promise<{
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
  }> {
    const deps = dependencies(
      workspace,
      clients.get("base")!,
      clients,
      createTabId,
    );
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { controller, deps };
  }

  it("removes an inactive tab and releases only that client", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    const result = await controller.closeConversation("tab-b");
    expect(result).toMatchObject({ tabId: "tab-b" });
    expect(result.workspace.activeTabId).toBe("base");
    expect(result.workspace.tabs.map((tab) => tab.id)).toEqual(["base"]);
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("tab-b");
    expect(target.connect).not.toHaveBeenCalled();
  });

  it("commits workspace removal without awaiting replacement readiness", async () => {
    const history = deferred<HermesHistoryItem[]>();
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    target.loadSessionHistory = vi.fn(() => history.promise);
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    const closing = controller.closeConversation("base");

    // Close must complete without replacement history loading
    await expect(closing).resolves.toMatchObject({ tabId: "base" });
    // Old tab removed, replacement (tab-b) active
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id)).toEqual(["tab-b"]);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-b");
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("base");
    history.resolve([]);
  });

  it("creates a deferred replacement for the last tab without connecting", async () => {
    const replacement = fakeClient("replacement");
    const base = fakeClient("base");
    const { controller, deps } = await readyCloseController(
      createConversationWorkspace("base", "base-session"),
      new Map([
        ["base", base],
        ["replacement", replacement],
      ]),
      () => "replacement",
    );

    const result = await controller.closeConversation("base");
    expect(result.replacementTabId).toBe("replacement");
    // Replacement is deferred (has no session yet)
    expect(result.workspace.tabs.some((tab) => tab.id === "replacement")).toBe(true);
    expect(result.workspace.tabs.some((tab) => tab.id === "base")).toBe(false);
    expect(replacement.connect).not.toHaveBeenCalled();
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("base");
  });

  it("succeeds active close without needing to prepare replacement client", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    const result = await controller.closeConversation("base");
    // Close succeeds, old tab removed, successor activated
    expect(result.workspace.activeTabId).toBe("tab-b");
    expect(result.workspace.tabs.map((tab) => tab.id)).toEqual(["tab-b"]);
    // target's connect was NOT called by close
    expect(target.connect).not.toHaveBeenCalled();
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("base");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("tab-b");
  });

  it("rejects closing a missing tab without changing workspace", async () => {
    const base = fakeClient("base");
    const { controller, deps } = await readyCloseController(
      createConversationWorkspace("base", "base-session"),
      new Map([["base", base]]),
    );

    await expect(controller.closeConversation("missing")).rejects.toMatchObject({
      code: "workspace_conflict",
      tabId: "missing",
    });
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id)).toEqual(["base"]);
  });

  it("rejects closing a busy target without affecting other tabs", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    controller.setPromptRunning("base", true);
    await expect(controller.closeConversation("base")).rejects.toMatchObject({
      code: "operation_stale",
      tabId: "base",
    });
    // Workspace unchanged — old tab still present.
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id)).toEqual(["base", "tab-b"]);
    expect(deps.clients.releaseClient).not.toHaveBeenCalled();
  });

  it("allows closing idle tab-b while tab-a is busy", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    controller.setPromptRunning("base", true);
    // Closing idle tab-b should succeed even though base is busy.
    const result = await controller.closeConversation("tab-b");
    expect(result).toMatchObject({ tabId: "tab-b" });
    expect(result.workspace.tabs.map((tab) => tab.id)).toEqual(["base"]);
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("tab-b");
    // base was not released.
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
  });

  it("rejects duplicate close of an already-closing tab", async () => {
    const history = deferred<HermesHistoryItem[]>();
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    target.loadSessionHistory = vi.fn(() => history.promise);
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    const firstClose = controller.closeConversation("base");
    // While the first close is still preparing, a second close of the same tab should be rejected.
    await expect(controller.closeConversation("base")).rejects.toMatchObject({
      code: "operation_stale",
      tabId: "base",
    });
    history.resolve([]);
    await firstClose;
    expect(deps.clients.releaseClient).toHaveBeenCalledTimes(1);
  });

  // ── Phase 2R RED tests adapted for fast-close: replacement failure does not block close ──

  it("commits the last-tab replacement without connecting it", async () => {
    const replacement = fakeClient("replacement");
    const base = fakeClient("base");
    const { controller } = await readyCloseController(
      createConversationWorkspace("base", "base-session"),
      new Map([
        ["base", base],
        ["replacement", replacement],
      ]),
      () => "replacement",
    );

    const result = await controller.closeConversation("base");
    // Replacement is present and deferred
    expect(result.replacementTabId).toBe("replacement");
    expect(result.workspace.tabs.some((tab) => tab.id === "replacement")).toBe(true);
    expect(result.workspace.tabs.some((tab) => tab.id === "base")).toBe(false);
    // Replacement was NOT connected during close
    expect(replacement.connect).not.toHaveBeenCalled();
  });

  // ── Remaining persistence-failure tests ──

  it("does not release the old client when structural persistence commit fails", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws, opts) => {
      if (opts?.save) {
        throw new Error("persistence write failed");
      }
      return originalSetWorkspace(ws, opts);
    });

    await expect(controller.closeConversation("tab-b")).rejects.toThrow(
      "persistence write failed",
    );
    // Old client must not be released when persistence fails.
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("tab-b");
    // The in-memory workspace must not be corrupted — old tab still present.
    const ws = deps.workspace.getWorkspace()!;
    expect(ws.tabs.map((tab) => tab.id)).toEqual(["base", "tab-b"]);
  });

  it("keeps snapshot and persisted workspace consistent after close commit failure", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws, opts) => {
      if (opts?.save) {
        throw new Error("persistence write failed");
      }
      return originalSetWorkspace(ws, opts);
    });

    await expect(controller.closeConversation("tab-b")).rejects.toThrow(
      "persistence write failed",
    );
    // Snapshot and persisted workspace must agree — no split.
    const snapshot = controller.getSnapshot();
    const persisted = deps.workspace.getWorkspace()!;
    expect(snapshot.workspace?.tabs.map((tab) => tab.id)).toEqual(
      persisted.tabs.map((tab) => tab.id),
    );
    expect(snapshot.workspace?.activeTabId).toBe(persisted.activeTabId);
    // Target tab must not appear as "closed" in snapshot operations state.
    expect(snapshot.tabOperations.get("tab-b")?.closing).toBeFalsy();
  });

  it("keeps the active tab visible when close commit fails", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const tabB = fakeClient("tab-b");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", tabB],
      ]),
    );
    deps.workspace.setWorkspace = vi.fn((_nextWorkspace, options) => {
      if (options?.save) {
        throw new Error("persistence write failed");
      }
    });

    await expect(controller.closeConversation("base")).rejects.toThrow(
      "persistence write failed",
    );

    const snapshot = controller.getSnapshot();
    const persisted = deps.workspace.getWorkspace()!;
    expect(snapshot.workspace?.tabs.map((tab) => tab.id)).toEqual([
      "base",
      "tab-b",
    ]);
    expect(snapshot.workspace?.activeTabId).toBe("base");
    expect(snapshot.workspace).toEqual(persisted);
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
  });

  // --- Phase 2R.2B RED tests: Close/Switch transition isolation ---

  it("does not cancel an in-flight switch when closing an inactive tab", async () => {
    const switchHistory = deferred<HermesHistoryItem[]>();
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "tab-c-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const tabB = fakeClient("tab-b");
    const tabC = fakeClient("tab-c");
    tabC.loadSessionHistory = vi.fn(() => switchHistory.promise);
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", tabB],
        ["tab-c", tabC],
      ]),
    );

    controller.setPromptRunning("base", true);
    const switchToC = controller.switchConversation("tab-c");
    const closeB = controller.closeConversation("tab-b");
    switchHistory.resolve([]);

    const [switchResult, closeResult] = await Promise.all([switchToC, closeB]);
    expect(switchResult.workspace.activeTabId).toBe("tab-c");
    expect(closeResult).toMatchObject({ tabId: "tab-b" });
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id).sort()).toEqual([
      "base",
      "tab-c",
    ]);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
    expect(controller.getSnapshot().tabOperations.get("base")?.prompt).toBe("running");
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("tab-b");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("tab-c");
  });

  it("does not let a delayed inactive close overwrite a newer switch commit", async () => {
    const closePersistence = deferred<void>();
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "tab-c-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const tabB = fakeClient("tab-b");
    const tabC = fakeClient("tab-c");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", tabB],
        ["tab-c", tabC],
      ]),
    );
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn(async (
      nextWorkspace: PersistedConversationWorkspace,
      options?: { flush?: boolean; save?: boolean },
    ) => {
      if (!nextWorkspace.tabs.some((tab) => tab.id === "tab-b")) {
        await closePersistence.promise;
      }
      return originalSetWorkspace(nextWorkspace, options);
    });

    const closeB = controller.closeConversation("tab-b");
    await Promise.resolve();
    const switchToC = controller.switchConversation("tab-c");
    await Promise.resolve();
    closePersistence.resolve();

    const [closeResult, switchResult] = await Promise.all([closeB, switchToC]);
    expect(closeResult).toMatchObject({ tabId: "tab-b" });
    expect(switchResult.workspace.activeTabId).toBe("tab-c");
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id).sort()).toEqual([
      "base",
      "tab-c",
    ]);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
    expect(controller.getSnapshot().workspace?.activeTabId).toBe("tab-c");
  });

  it("bases a switch on the latest workspace after an inactive close commits", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "tab-c-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", fakeClient("tab-b")],
        ["tab-c", fakeClient("tab-c")],
      ]),
    );

    await controller.closeConversation("tab-b");
    const switchResult = await controller.switchConversation("tab-c");

    expect(switchResult.workspace.tabs.map((tab) => tab.id).sort()).toEqual([
      "base",
      "tab-c",
    ]);
    expect(switchResult.workspace.activeTabId).toBe("tab-c");
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
  });

  it("preserves a committed switch when an inactive close commits afterward", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "tab-c-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", fakeClient("tab-b")],
        ["tab-c", fakeClient("tab-c")],
      ]),
    );

    await controller.switchConversation("tab-c");
    const closeResult = await controller.closeConversation("tab-b");

    expect(closeResult.workspace.activeTabId).toBe("tab-c");
    expect(closeResult.workspace.tabs.map((tab) => tab.id).sort()).toEqual([
      "base",
      "tab-c",
    ]);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
  });

  it("closure and switch coexist without mutual cancellation", async () => {
    const closePersist = deferred<void>();
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "session-c");
    workspace = { ...workspace, activeTabId: "base" };
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([["base", fakeClient("base")], ["tab-b", fakeClient("tab-b")], ["tab-c", fakeClient("tab-c")]]),
    );
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws: PersistedConversationWorkspace, opts?: { flush?: boolean; save?: boolean }) => {
      if (opts?.save && !ws.tabs.some((t) => t.id === "base")) {
        return closePersist.promise.then(() => originalSetWorkspace(ws, opts));
      }
      return originalSetWorkspace(ws, opts);
    });

    const closeBase = controller.closeConversation("base");
    await Promise.resolve();
    const switchToC = controller.switchConversation("tab-c");
    // Switch queues behind close persistence in serialized workspace commit
    closePersist.resolve();
    await Promise.resolve();

    const closeResult = await closeBase;
    // Switch wins: tab-c is active after close removes base
    await switchToC;

    // Close removes base; switch wins active owner
    expect(closeResult.workspace.tabs.some((t) => t.id === "base")).toBe(false);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
    expect(deps.workspace.getWorkspace()?.tabs.map((t) => t.id).sort()).toEqual(["tab-b", "tab-c"]);
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("base");
  });

  // ── Close-UX RED tests: close must commit before replacement readiness ──

  it("commits active close before replacement history finishes", async () => {
    const history = deferred<HermesHistoryItem[]>();
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-a" };

    const tabA = fakeClient("tab-a");
    const tabB = fakeClient("tab-b");
    // Replacement history stays pending until we explicitly resolve
    tabB.loadSessionHistory = vi.fn(() => history.promise);
    const { controller } = await readyCloseController(
      workspace,
      new Map([["tab-a", tabA], ["tab-b", tabB]]),
    );

    // B is unloaded (not yet hydrated) since it was inactive
    controller.setPromptRunning("tab-a", false);

    const close = controller.closeConversation("tab-a");

    // Even while replacement history is still pending,
    // the close must have committed the workspace removal
    await vi.waitFor(() => {
      const ws = controller.getSnapshot().workspace!;
      expect(ws.tabs.map((t) => t.id)).toEqual(["tab-b"]);
      expect(ws.activeTabId).toBe("tab-b");
    }, { timeout: 2000 });

    // Now resolve history — close should already be settled
    history.resolve([{ kind: "user", text: "b-history" }]);
    await expect(close).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("does not await replacement connect before committing close", async () => {
    const connectDeferred = deferred<void>();
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-a" };

    const tabA = fakeClient("tab-a");
    const tabB = fakeClient("tab-b");
    tabB.connect = vi.fn(() => connectDeferred.promise);
    const { controller } = await readyCloseController(
      workspace,
      new Map([["tab-a", tabA], ["tab-b", tabB]]),
    );

    const close = controller.closeConversation("tab-a");

    // Workspace must commit without waiting for B's connect
    await vi.waitFor(() => {
      const ws = controller.getSnapshot().workspace!;
      expect(ws.tabs.map((t) => t.id)).toEqual(["tab-b"]);
    }, { timeout: 2000 });

    connectDeferred.resolve();
    await expect(close).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("does not await old client disconnect after close commit", async () => {
    const disconnectDeferred = deferred<void>();
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-a" };

    const tabA = fakeClient("tab-a");
    tabA.disconnect = vi.fn(() => disconnectDeferred.promise);
    const tabB = fakeClient("tab-b");
    const { controller } = await readyCloseController(
      workspace,
      new Map([["tab-a", tabA], ["tab-b", tabB]]),
    );

    // Replace the default releaseClient (which is a no-op mock) with one
    // that actually calls disconnect
    const originalRelease = controller["dependencies"].clients.releaseClient;
    controller["dependencies"].clients.releaseClient = vi.fn(async (releaseId: string) => {
      const client = controller["dependencies"].clients.getClient(releaseId);
      if (client) {
        await client.disconnect();
      }
      return originalRelease(releaseId);
    });

    const close = controller.closeConversation("tab-a");

    // Close must resolve even while old client disconnect is pending
    await expect(close).resolves.toMatchObject({ tabId: "tab-a" });
    // tab-a must be gone from workspace
    expect(controller.getSnapshot().workspace?.tabs.map((t) => t.id)).toEqual(["tab-b"]);

    disconnectDeferred.resolve();
  });

  it("last-tab close commits replacement before replacement connects", async () => {
    const connectDeferred = deferred<void>();
    const replacement = fakeClient("replacement");
    replacement.connect = vi.fn(() => connectDeferred.promise);
    const tabA = fakeClient("tab-a");

    const { controller } = await readyCloseController(
      createConversationWorkspace("tab-a", "session-a"),
      new Map([["tab-a", tabA], ["replacement", replacement]]),
      () => "replacement",
    );

    const close = controller.closeConversation("tab-a");

    // Replacement must appear in workspace before its connect resolves
    await vi.waitFor(() => {
      const ws = controller.getSnapshot().workspace!;
      expect(ws.tabs.some((t) => t.id === "replacement")).toBe(true);
    }, { timeout: 2000 });

    connectDeferred.resolve();
    await expect(close).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("does not leak pending promises after rapid consecutive closes", async () => {
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "session-c");
    workspace = { ...workspace, activeTabId: "tab-a" };
    const clients = new Map([
      ["tab-a", fakeClient("tab-a")],
      ["tab-b", fakeClient("tab-b")],
      ["tab-c", fakeClient("tab-c")],
    ]);
    const { controller } = await readyCloseController(workspace, clients);

    const [resultA, resultB] = await Promise.all([
      controller.closeConversation("tab-a"),
      controller.closeConversation("tab-b"),
    ]);

    // Close-a commits first: removes tab-a, activates tab-b
    expect(resultA.workspace.tabs.map((t) => t.id)).toEqual(["tab-b", "tab-c"]);
    expect(resultA.workspace.activeTabId).toBe("tab-b");
    // Close-b commits second: reads latest, removes tab-b, activates tab-c
    expect(resultB.workspace.tabs.map((t) => t.id)).toEqual(["tab-c"]);
    expect(resultB.workspace.activeTabId).toBe("tab-c");
  });

  it("rejects a second active close while the first is committing", async () => {
    const persist = deferred<void>();
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-a" };
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([["tab-a", fakeClient("tab-a")], ["tab-b", fakeClient("tab-b")]]),
    );
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws: PersistedConversationWorkspace, opts?: { flush?: boolean; save?: boolean }) => {
      if (opts?.save && ws.activeTabId !== "tab-a") {
        return persist.promise.then(() => originalSetWorkspace(ws, opts));
      }
      return originalSetWorkspace(ws, opts);
    });

    const closeA = controller.closeConversation("tab-a");
    await Promise.resolve();
    await expect(controller.closeConversation("tab-a")).rejects.toMatchObject({
      code: "operation_stale",
    });
    persist.resolve();
    await closeA;
  });

  it("does not resurrect a closed tab after close succeeds", async () => {
    const replacement = fakeClient("replacement");
    const base = fakeClient("base");
    const { controller } = await readyCloseController(
      createConversationWorkspace("base", "base-session"),
      new Map([["base", base], ["replacement", replacement]]),
      () => "replacement",
    );

    const result = await controller.closeConversation("base");
    expect(result.workspace.tabs.some((t) => t.id === "base")).toBe(false);
    expect(result.replacementTabId).toBe("replacement");
  });

  it("yields replacementTabId and active owner when closing the last tab", async () => {
    const replacement = fakeClient("replacement");
    const { controller } = await readyCloseController(
      createConversationWorkspace("only", "only-session"),
      new Map([["only", fakeClient("only")], ["replacement", replacement]]),
      () => "replacement",
    );

    const result = await controller.closeConversation("only");
    expect(result.replacementTabId).toBe("replacement");
    expect(result.workspace.activeTabId).toBe("replacement");
  });

  // ── Visibility linearization: close + concurrent navigation ──

  it("commits close and lets a queued switch win", async () => {
    const closePersist = deferred<void>();
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "session-c");
    workspace = { ...workspace, activeTabId: "tab-a" };
    const clientA = fakeClient("tab-a");
    const clientC = fakeClient("tab-c");
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([["tab-a", clientA], ["tab-b", fakeClient("tab-b")], ["tab-c", clientC]]),
    );
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws: PersistedConversationWorkspace, opts?: { flush?: boolean; save?: boolean }) => {
      if (opts?.save && !ws.tabs.some((t) => t.id === "tab-a")) {
        return closePersist.promise.then(() => originalSetWorkspace(ws, opts));
      }
      return originalSetWorkspace(ws, opts);
    });

    const closeA = controller.closeConversation("tab-a");
    await Promise.resolve();
    const switchC = controller.switchConversation("tab-c");
    await Promise.resolve();
    closePersist.resolve();

    const [closeResult, switchResult] = await Promise.all([closeA, switchC]);
    // Close removes tab-a; successor (tab-b) is initial active
    expect(closeResult.workspace.tabs.map((t) => t.id)).toEqual(["tab-b", "tab-c"]);
    // Switch wins: tab-c is now active
    expect(switchResult.workspace.activeTabId).toBe("tab-c");
    // Final persisted state: tab-c active
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
    expect(deps.workspace.getWorkspace()?.tabs.map((t) => t.id).sort()).toEqual(["tab-b", "tab-c"]);
  });

  it("rejects close when persistence fails and queued switch succeeds on original workspace", async () => {
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-a" };
    const clients = new Map([["tab-a", fakeClient("tab-a")], ["tab-b", fakeClient("tab-b")]]);
    const { controller, deps } = await readyCloseController(workspace, clients);
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws: PersistedConversationWorkspace, opts?: { flush?: boolean; save?: boolean }) => {
      if (opts?.save && !ws.tabs.some((t) => t.id === "tab-a")) {
        throw new Error("persistence write failed");
      }
      return originalSetWorkspace(ws, opts);
    });

    const closeA = controller.closeConversation("tab-a");
    await Promise.resolve();
    const switchB = controller.switchConversation("tab-b");

    await expect(closeA).rejects.toThrow("persistence write failed");
    const switchResult = await switchB;
    expect(switchResult.workspace.activeTabId).toBe("tab-b");
    // tab-a still present
    expect(deps.workspace.getWorkspace()?.tabs.map((t) => t.id).sort()).toEqual(["tab-a", "tab-b"]);
  });
});

describe("ConversationController history and restart", () => {
  async function readySessionController(
    workspace: ReturnType<typeof createConversationWorkspace>,
    clients: Map<string, FakeClient>,
  ): Promise<{
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
  }> {
    const deps = dependencies(workspace, clients.get("base")!, clients);
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { controller, deps };
  }

  function workspaceWithPendingTabs(...tabIds: string[]): ReturnType<typeof createConversationWorkspace> {
    let workspace = createConversationWorkspace("base", "base-session");
    for (const tabId of tabIds) {
      workspace = addPendingConversationTab(workspace, tabId);
    }
    return { ...workspace, activeTabId: "base" };
  }

  it("binds the captured target tab even when active tab changes while loading", async () => {
    const history = deferred<HermesHistoryItem[]>();
    const target = fakeClient("tab-b");
    target.loadSessionHistory = vi.fn(async (sessionId: string) => {
      const items = await history.promise;
      target.sessionId = sessionId;
      return items;
    });
    const workspace = workspaceWithPendingTabs("tab-b");
    const { controller, deps } = await readySessionController(
      workspace,
      new Map([
        ["base", fakeClient("base")],
        ["tab-b", target],
      ]),
    );

    const binding = controller.bindHistorySession("tab-b", "history-session");
    deps.workspace.setWorkspace({
      ...deps.workspace.getWorkspace()!,
      activeTabId: "base",
    });
    history.resolve([{ kind: "user", text: "history" }]);

    const result = await binding;
    expect(result).toMatchObject({ sessionId: "history-session", tabId: "tab-b" });
    expect(result.workspace.activeTabId).toBe("base");
    expect(result.workspace.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tab-b", sessionId: "history-session" })]),
    );
  });

  it("reserves a history session so concurrent tabs cannot bind it twice", async () => {
    const history = deferred<HermesHistoryItem[]>();
    const first = fakeClient("tab-b");
    first.loadSessionHistory = vi.fn(() => history.promise);
    const second = fakeClient("tab-c");
    const { controller } = await readySessionController(
      workspaceWithPendingTabs("tab-b", "tab-c"),
      new Map([
        ["base", fakeClient("base")],
        ["tab-b", first],
        ["tab-c", second],
      ]),
    );

    const firstBinding = controller.bindHistorySession("tab-b", "same-session");
    await expect(controller.bindHistorySession("tab-c", "same-session")).rejects.toMatchObject({
      code: "session_reserved",
      tabId: "tab-c",
    });
    history.resolve([]);
    await expect(firstBinding).resolves.toMatchObject({ tabId: "tab-b" });
    expect(second.loadSessionHistory).not.toHaveBeenCalled();
  });

  it("activates an existing session owner without loading it again", async () => {
    let workspace = workspaceWithPendingTabs("tab-b", "tab-c");
    workspace = replaceConversationSession(workspace, "tab-b", "history-session");
    const base = fakeClient("base");
    const owner = fakeClient("tab-b");
    const target = fakeClient("tab-c");
    const { controller, deps } = await readySessionController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", owner],
        ["tab-c", target],
      ]),
    );

    const result = await controller.bindHistorySession("tab-c", "history-session");
    expect(result.ownerTabId).toBe("tab-b");
    expect(result.workspace.activeTabId).toBe("tab-b");
    expect(target.loadSessionHistory).not.toHaveBeenCalled();
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-b");
  });

  it("does not replace a target binding when history loading fails", async () => {
    const target = fakeClient("tab-b");
    target.loadSessionHistory = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    const { controller, deps } = await readySessionController(
      workspaceWithPendingTabs("tab-b"),
      new Map([
        ["base", fakeClient("base")],
        ["tab-b", target],
      ]),
    );

    await expect(controller.bindHistorySession("tab-b", "history-session")).rejects.toThrow(
      "history unavailable",
    );
    expect(deps.workspace.getWorkspace()?.tabs.find((tab) => tab.id === "tab-b")?.sessionId).toBe(
      null,
    );
  });

  it("restarts only the requested tab and persists the new session", async () => {
    let workspace = workspaceWithPendingTabs("tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "old-session");
    const target = fakeClient("tab-b");
    target.sessionId = "new-session";
    target.newSession = vi.fn(async () => undefined);
    const { controller, deps } = await readySessionController(
      workspace,
      new Map([
        ["base", fakeClient("base")],
        ["tab-b", target],
      ]),
    );

    const result = await controller.restartConversation("tab-b");
    expect(result).toMatchObject({ sessionId: "new-session", tabId: "tab-b" });
    expect(result.workspace.tabs).toHaveLength(2);
    expect(result.workspace.tabs.find((tab) => tab.id === "tab-b")?.sessionId).toBe("new-session");
    expect(deps.workspace.getWorkspace()?.tabs.find((tab) => tab.id === "tab-b")?.sessionId).toBe(
      "new-session",
    );
  });

  it("keeps the old binding when restart fails", async () => {
    let workspace = workspaceWithPendingTabs("tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "old-session");
    const target = fakeClient("tab-b");
    target.newSession = vi.fn(async () => {
      throw new Error("restart unavailable");
    });
    const { controller, deps } = await readySessionController(
      workspace,
      new Map([
        ["base", fakeClient("base")],
        ["tab-b", target],
      ]),
    );

    await expect(controller.restartConversation("tab-b")).rejects.toThrow("restart unavailable");
    expect(deps.workspace.getWorkspace()?.tabs.find((tab) => tab.id === "tab-b")?.sessionId).toBe(
      "old-session",
    );
  });

  it("connects an inactive tab lazily on first switch, then reuses it", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = {
      ...workspace,
      activeTabId: "base",
    };
    const clientB = fakeClient("tab-b");
    clientB.sessionId = "tab-b-session";
    const connectSpy = vi.spyOn(clientB, "connect");
    const { controller } = await readySessionController(
      workspace,
      new Map([
        ["base", fakeClient("base")],
        ["tab-b", clientB],
      ]),
    );

    // First switch — must lazily hydrate
    const result = await controller.switchConversation("tab-b");
    expect(result.tabId).toBe("tab-b");
    expect(result.started).toBe(false);
    expect(result.workspace.activeTabId).toBe("tab-b");
    expect(connectSpy).toHaveBeenCalledOnce();

    // Switch back to base, then back to tab-b — no repeat connect
    await controller.switchConversation("base");
    connectSpy.mockClear();
    await controller.switchConversation("tab-b");
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("ConversationController openHistorySession", () => {
  async function readySessionController(
    workspace: ReturnType<typeof createConversationWorkspace>,
    clients: Map<string, FakeClient>,
  ): Promise<{
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
  }> {
    let n = 0;
    const deps = dependencies(workspace, clients.get("base")!, clients, () => `tab-new-${++n}`);
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { controller, deps };
  }

  it("creates a new tab for an unopened history session", async () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const clients = new Map([["tab-a", fakeClient("tab-a")]]);
    const { controller, deps } = await readySessionController(workspace, clients);

    // Create a client factory for new tabs
    let createdTabId = "";
    const newClient = fakeClient("new-client");
    newClient.sessionId = "new-history-session";
    deps.clients.acquireClient = vi.fn((tabId: string) => {
      createdTabId = tabId;
      return newClient;
    });
    deps.clients.isCurrentClient = vi.fn(() => true);

    const result = await controller.openHistorySession("new-history-session");

    expect(result.reused).toBe(false);
    expect(result.tabId).toBe(createdTabId);
    expect(result.sessionId).toBe("new-history-session");
    // Original tab preserved
    expect(result.workspace.tabs.find((t) => t.id === "tab-a")!.sessionId).toBe("session-a");
  });

  it("reuses an existing owner when the session is already open", async () => {
    let workspace = createConversationWorkspace("tab-a", "session-a");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "session-b");
    workspace = { ...workspace, activeTabId: "tab-a" };
    const clients = new Map([["tab-a", fakeClient("tab-a")], ["tab-b", fakeClient("tab-b")]]);
    const { controller } = await readySessionController(workspace, clients);

    const result = await controller.openHistorySession("session-b");

    expect(result.reused).toBe(true);
    expect(result.tabId).toBe("tab-b");
    // No new tab created
    expect(result.workspace.tabs).toHaveLength(2);
  });

  it("rolls back on failure and preserves the original workspace", async () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const clients = new Map([["tab-a", fakeClient("tab-a")]]);
    const { controller, deps } = await readySessionController(workspace, clients);

    // Simulate a client that fails on connect
    const failingClient = fakeClient("failing");
    failingClient.connect = vi.fn(() => Promise.reject(new Error("connect failed")));
    const acquireSpy = vi.fn(() => failingClient);
    deps.clients.acquireClient = acquireSpy;
    deps.clients.isCurrentClient = vi.fn(() => true);

    await expect(controller.openHistorySession("doomed-session")).rejects.toThrow(
      "connect failed",
    );

    // Workspace must be restored to original
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace?.tabs).toHaveLength(1);
    expect(snapshot.workspace?.activeTabId).toBe("tab-a");
  });
});

describe("ConversationController client and permission state", () => {
  function sessionState(switchingModel = false) {
    return {
      catalogLoading: false,
      commands: [],
      models: [],
      skillCatalogLoading: false,
      skills: [],
      switchingModel,
    };
  }

  it("stores the first session-state replay in the controller snapshot", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();
    controller.updateClientState("base", sessionState(true));

    expect(controller.getSnapshot().sessionStates.get("base")).toMatchObject({
      switchingModel: true,
    });
    expect(controller.getSnapshot().tabOperations.get("base")).toMatchObject({
      sessionOperation: "model",
    });
  });

  it("drops factory-time session state when client is acquired before publish", async () => {
    const workspace = createConversationWorkspace("base", "base-session");
    let currentWorkspace = workspace;
    let capturedController: ConversationController<FakeClient> | undefined;
    const newClient = fakeClient("new-tab");
    const factoryState = sessionState(true);

    const deps: ConversationControllerDependencies<FakeClient> = {
      clients: {
        acquireClient: vi.fn((tabId: string) => {
          capturedController?.updateClientState(tabId, factoryState);
          return newClient;
        }),
        getClient: vi.fn(() => newClient),
        isCurrentClient: vi.fn(() => true),
        releaseClient: vi.fn(async () => undefined),
      },
      workspace: {
        getWorkspace: vi.fn(() => currentWorkspace),
        setWorkspace: vi.fn((next) => {
          currentWorkspace = next;
        }),
      },
      createTabId: () => "new-tab",
    };

    const controller = new ConversationController(deps);
    capturedController = controller;
    await controller.initialize();
    await controller.addConversation();

    expect(controller.getSnapshot().sessionStates.get("new-tab")).toBeDefined();
    expect(controller.getSnapshot().sessionStates.get("new-tab")).toMatchObject({
      switchingModel: true,
    });
  });

  it("ignores state replay for a stale or unknown tab slot", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();
    controller.updateClientState("stale-tab", sessionState());

    expect(controller.getSnapshot().sessionStates.has("stale-tab")).toBe(false);
    expect(controller.getSnapshot().tabOperations.has("stale-tab")).toBe(false);
  });

  it("keeps permission cleanup isolated between tabs", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    const controller = new ConversationController(
      dependencies(workspace, fakeClient("base"), new Map([
        ["base", fakeClient("base")],
        ["tab-b", fakeClient("tab-b")],
      ])),
    );
    await controller.initialize();
    controller.beginPermission("base", "base:permission");
    controller.beginPermission("tab-b", "tab-b:permission");
    controller.completePermission("base:permission");

    expect(controller.getSnapshot().tabOperations.get("base")?.permissionPending).toBe(false);
    expect(controller.getSnapshot().tabOperations.get("tab-b")?.permissionPending).toBe(true);
    controller.completePermission("tab-b:permission");
    expect(controller.getSnapshot().tabOperations.get("tab-b")?.permissionPending).toBe(false);
  });

  it("keeps prompt busy state independent between tabs", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    const controller = new ConversationController(
      dependencies(workspace, fakeClient("base"), new Map([
        ["base", fakeClient("base")],
        ["tab-b", fakeClient("tab-b")],
      ])),
    );
    await controller.initialize();
    controller.setPromptRunning("base", true);
    controller.setPromptRunning("tab-b", true);
    controller.setPromptRunning("base", false);

    expect(controller.getSnapshot().tabOperations.get("base")?.prompt).toBe("idle");
    expect(controller.getSnapshot().tabOperations.get("tab-b")?.prompt).toBe("running");
  });
});

describe("ConversationController permission reveal", () => {
  async function readyControllerWithTabs(
    ...tabIds: string[]
  ): Promise<{
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
    clients: Map<string, FakeClient>;
  }> {
    let workspace = createConversationWorkspace("base", "base-session");
    const clients = new Map<string, FakeClient>([["base", fakeClient("base")]]);
    for (const targetId of tabIds) {
      const target = fakeClient(targetId);
      clients.set(targetId, target);
      workspace = addPendingConversationTab(workspace, targetId);
      workspace = replaceConversationSession(workspace, targetId, `${targetId}-session`);
    }
    workspace = { ...workspace, activeTabId: "base" };
    const deps = dependencies(workspace, clients.get("base")!, clients);
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { controller, deps, clients };
  }

  it("reveals hidden tab for permission through controller", async () => {
    const { controller, deps } = await readyControllerWithTabs("tab-b");

    controller.beginPermission("tab-b", "tab-b:perm-1");
    await controller.revealForPermission("tab-b", "tab-b:perm-1");

    const ws = deps.workspace.getWorkspace();
    expect(ws?.activeTabId).toBe("tab-b");
    expect(controller.getSnapshot().tabOperations.get("tab-b")?.permissionPending).toBe(true);
    expect(controller.getSnapshot().tabOperations.get("base")?.closing).toBe(false);
  });

  it("stales a delayed switch when permission invalidates transition", async () => {
    const { controller, deps, clients } = await readyControllerWithTabs("tab-b", "tab-c");
    const loadC = deferred<HermesHistoryItem[]>();
    clients.get("tab-c")!.loadSessionHistory = vi.fn(() => loadC.promise);

    const switchingC = controller.switchConversation("tab-c");
    controller.beginPermission("tab-b", "tab-b:perm-1");
    await controller.revealForPermission("tab-b", "tab-b:perm-1");

    loadC.resolve([]);
    await expect(switchingC).rejects.toMatchObject({ code: "cancelled" });

    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-b");
  });

  it("rejects explicit switch while permission is pending", async () => {
    const { controller, deps } = await readyControllerWithTabs("tab-b", "tab-c");

    controller.beginPermission("tab-b", "tab-b:perm-1");
    await controller.revealForPermission("tab-b", "tab-b:perm-1");

    await expect(controller.switchConversation("tab-c")).rejects.toMatchObject({
      code: "cancelled",
    });

    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-b");
  });

  it("clears permission pending on complete", async () => {
    const { controller } = await readyControllerWithTabs("tab-b");

    controller.beginPermission("tab-b", "tab-b:perm-1");
    controller.completePermission("tab-b:perm-1");

    expect(controller.getSnapshot().tabOperations.get("tab-b")?.permissionPending).toBe(false);
  });
});

describe("ConversationController snapshot isolation", () => {
  it("rejects Map mutation through tabOperations cast", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();

    const snap = controller.getSnapshot();
    const before = snap.tabOperations.get("base");

    expect(() => {
      (snap.tabOperations as unknown as Map<string, unknown>).set("hacked", {});
    }).toThrow();

    expect(snap.tabOperations.get("base")).toBe(before);
    expect(snap.tabOperations.has("hacked")).toBe(false);
  });

  it("rejects Map mutation through sessionStates cast", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();
    controller.updateClientState("base", {
      catalogLoading: false,
      commands: [],
      models: [],
      skillCatalogLoading: false,
      skills: [],
      switchingModel: false,
    });

    const snap = controller.getSnapshot();

    expect(() => {
      (snap.sessionStates as unknown as Map<string, unknown>).clear();
    }).toThrow();

    expect(snap.sessionStates.has("base")).toBe(true);
  });

  it("rejects Map mutation through controls.byTab cast", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();

    const snap = controller.getSnapshot();

    expect(() => {
      (snap.controls.byTab as unknown as Map<string, unknown>).delete("base");
    }).toThrow();

    expect(snap.controls.byTab.has("base")).toBe(true);
  });

  it("rejects workspace tabs array mutation", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();

    const snap = controller.getSnapshot();
    const tabCount = snap.workspace!.tabs.length;

    expect(() => {
      (snap.workspace!.tabs as unknown as { label: number }[]).push({ label: 999 });
    }).toThrow();

    expect(snap.workspace!.tabs).toHaveLength(tabCount);
  });

  it("preserves subsequent snapshots after a listener mutation attempt", async () => {
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("base", "base-session"), fakeClient("base")),
    );
    await controller.initialize();

    const snap1 = controller.getSnapshot();
    try {
      (snap1.tabOperations as unknown as Map<string, unknown>).set("hacked", {});
    } catch { /* expected */ }

    controller.setPromptRunning("base", true);
    const snap2 = controller.getSnapshot();

    expect(snap2.tabOperations.has("hacked")).toBe(false);
    expect(snap1.tabOperations.has("hacked")).toBe(false);
  });
});

describe("ConversationController ensureConversationReady", () => {
  async function readyHydrationController(
    tabState: "unloaded" | "deferred" | "ready" = "ready",
  ): Promise<{
    controller: ConversationController<FakeClient>;
    deps: ConversationControllerDependencies<FakeClient>;
    clients: Map<string, FakeClient>;
  }> {
    // Build workspace directly to control sessionId
    const sessionId = tabState === "ready" || tabState === "unloaded" ? "main-session" : null;
    let workspace = {
      activeTabId: "main",
      nextLabel: 2,
      tabs: [{
        draft: "",
        id: "main",
        includeCurrentDocumentContext: true,
        label: 1,
        sessionId,
      }],
      version: 2 as const,
    } as PersistedConversationWorkspace;
    const clients = new Map<string, FakeClient>();
    const main = fakeClient("main");
    clients.set("main", main);
    const deps = dependencies(workspace, main, clients);
    const controller = new ConversationController(deps);
    await controller.initialize();
    return { controller, deps, clients };
  }

  it("returns immediately for a ready owner without reconnecting", async () => {
    const { controller, clients } = await readyHydrationController("ready");
    // initialize already called connect+load, so main is ready
    const connectCount = (clients.get("main")!.connect as ReturnType<typeof vi.fn>).mock.calls.length;

    const result = await controller.ensureConversationReady("main");
    expect(result.tabId).toBe("main");
    expect((clients.get("main")!.connect as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(connectCount);
  });

  it("deduplicates concurrent hydration promises", async () => {
    const connect = deferred<void>();
    const { controller } = await readyHydrationController("ready");
    const injected = fakeClient("fresh");
    controller["dependencies"].clients.acquireClient = vi.fn(() => injected);
    injected.connect = vi.fn(async () => {
      await connect.promise;
      injected.sessionId = "hydrated-session";
    });

    const p1 = controller.ensureConversationReady("main");
    const p2 = controller.ensureConversationReady("main");

    // Both must resolve to the same hydration result
    connect.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.sessionId).toBe(r2.sessionId);
    expect(r1.tabId).toBe("main");
  });

  it("creates a new session for a deferred owner", async () => {
    const { controller, deps } = await readyHydrationController("ready");
    // Force main to deferred state
    controller["publish"]({
      ...controller.getSnapshot(),
      tabOperations: new Map(controller.getSnapshot().tabOperations).set(
        "main",
        Object.freeze({
          closing: false,
          connection: "deferred" as const,
          hasSession: false,
          permissionPending: false,
          prompt: "idle" as const,
          sessionOperation: "idle" as const,
        }),
      ),
    });
    const injected = fakeClient("fresh");
    injected.sessionId = undefined;
    injected.connect = vi.fn(async () => { injected.sessionId = "created-session"; });
    controller["dependencies"].clients.acquireClient = vi.fn(() => injected);

    const result = await controller.ensureConversationReady("main");
    expect(result.tabId).toBe("main");
    expect(result.sessionId).toBe("created-session");
    // Workspace should reflect the new session binding
    const ws = deps.workspace.getWorkspace()!;
    const tab = ws.tabs.find((t) => t.id === "main");
    expect(tab?.sessionId).toBe("created-session");
  });

  it("loads existing session for an unloaded owner", async () => {
    const history = deferred<HermesHistoryItem[]>();
    const { controller, clients } = await readyHydrationController("unloaded");
    const target = clients.get("main")!;
    target.connect = vi.fn(async () => undefined);
    target.loadSessionHistory = vi.fn(() => history.promise);
    // Force state to unloaded
    controller["publish"]({
      ...controller.getSnapshot(),
      tabOperations: new Map(controller.getSnapshot().tabOperations).set(
        "main",
        Object.freeze({
          closing: false,
          connection: "unloaded" as const,
          hasSession: true,
          permissionPending: false,
          prompt: "idle" as const,
          sessionOperation: "idle" as const,
        }),
      ),
    });

    const p = controller.ensureConversationReady("main");
    history.resolve([{ content: "hi", timestamp: "2024-01-01T00:00:00Z" } as unknown as HermesHistoryItem]);
    const result = await p;
    expect(result.items).toHaveLength(1);
    expect(target.connect).toHaveBeenCalled();
    expect(target.loadSessionHistory).toHaveBeenCalledWith("main-session");
  });


});
