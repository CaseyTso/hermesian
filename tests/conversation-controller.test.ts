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
      connection: "ready",
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

  it("does not depend on Obsidian or DOM globals", () => {
    const source = readFileSync(
      new URL("../src/conversation-controller.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from ["']obsidian["']/);
    expect(source).not.toMatch(/\bHTMLElement\b/);
  });

  it("accepts fake clients whose protocol operations can be deferred", async () => {
    const connect = deferred<void>();
    const client = fakeClient("tab-a");
    client.connect = vi.fn(() => connect.promise);
    const controller = new ConversationController(
      dependencies(createConversationWorkspace("tab-a", "session-a"), client),
    );

    expect(controller.getSnapshot().tabOperations.get("tab-a")?.connection).toBe("ready");
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

  it("prepares a replacement before removing the active tab", async () => {
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
    // While the replacement is still being prepared, the old tab must remain.
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id)).toEqual(["base", "tab-b"]);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("base");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
    history.resolve([]);

    const result = await closing;
    expect(result.workspace.activeTabId).toBe("tab-b");
    expect(result.workspace.tabs).toHaveLength(1);
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("base");
  });

  it("creates and connects a replacement when closing the last tab", async () => {
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

    const closing = controller.closeConversation("base");
    // While the replacement is being prepared, the old tab must remain.
    const pending = deps.workspace.getWorkspace()!;
    expect(pending.tabs.some((tab) => tab.id === "base")).toBe(true);
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
    const result = await closing;
    expect(result.replacementTabId).toBe("replacement");
    expect(result.workspace.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "replacement", sessionId: "replacement-session" })]),
    );
    expect(result.workspace.tabs.some((tab) => tab.id === "base")).toBe(false);
    expect(deps.clients.releaseClient).toHaveBeenCalledWith("base");
    expect(replacement.connect).toHaveBeenCalledOnce();
  });

  it("preserves the closed tab when replacement preparation fails", async () => {
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const target = fakeClient("tab-b");
    target.connect = vi.fn(async () => {
      throw new Error("replacement unavailable");
    });
    const { controller, deps } = await readyCloseController(
      workspace,
      new Map([
        ["base", base],
        ["tab-b", target],
      ]),
    );

    await expect(controller.closeConversation("base")).rejects.toThrow("replacement unavailable");
    // Failed replacement must not delete the old tab or release its client.
    expect(deps.workspace.getWorkspace()?.tabs.map((tab) => tab.id)).toEqual(["base", "tab-b"]);
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("base");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
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

  // --- Phase 2R.1B RED tests: replacement/persistence failure atomicity ---

  it("preserves the last tab when replacement connect fails", async () => {
    const replacement = fakeClient("replacement");
    replacement.connect = vi.fn(async () => {
      throw new Error("replacement connect failed");
    });
    const base = fakeClient("base");
    const { controller, deps } = await readyCloseController(
      createConversationWorkspace("base", "base-session"),
      new Map([
        ["base", base],
        ["replacement", replacement],
      ]),
      () => "replacement",
    );

    await expect(controller.closeConversation("base")).rejects.toThrow(
      "replacement connect failed",
    );
    // Old tab, activeTabId, binding, and client identity must be preserved.
    const ws = deps.workspace.getWorkspace()!;
    expect(ws.tabs.map((tab) => tab.id)).toEqual(["base"]);
    expect(ws.activeTabId).toBe("base");
    expect(ws.tabs[0]?.sessionId).toBe("base-session");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
  });

  it("preserves the last tab when replacement newSession fails", async () => {
    const replacement = fakeClient("replacement");
    replacement.sessionId = undefined; // force newSession path
    replacement.connect = vi.fn(async () => undefined);
    replacement.newSession = vi.fn(async () => {
      throw new Error("newSession failed");
    });
    const base = fakeClient("base");
    const { controller, deps } = await readyCloseController(
      createConversationWorkspace("base", "base-session"),
      new Map([
        ["base", base],
        ["replacement", replacement],
      ]),
      () => "replacement",
    );

    await expect(controller.closeConversation("base")).rejects.toMatchObject({
      code: "client_unavailable",
      tabId: "replacement",
    });
    const ws = deps.workspace.getWorkspace()!;
    expect(ws.tabs.map((tab) => tab.id)).toEqual(["base"]);
    expect(ws.activeTabId).toBe("base");
    expect(ws.tabs[0]?.sessionId).toBe("base-session");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("replacement");
  });

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

  it("does not leave a stale replacement in snapshot when active close commit fails", async () => {
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
    // Allow prepare (connect + session) to succeed, then fail at persistence.
    let setWorkspaceCalls = 0;
    const originalSetWorkspace = deps.workspace.setWorkspace;
    deps.workspace.setWorkspace = vi.fn((ws, opts) => {
      setWorkspaceCalls += 1;
      // First call: ensureClientForTabInternal persists replacement — let it succeed.
      // Second call: closeConversationInternal commits deletion — fail.
      if (setWorkspaceCalls >= 2 && opts?.save) {
        throw new Error("persistence write failed");
      }
      return originalSetWorkspace(ws, opts);
    });

    await expect(controller.closeConversation("base")).rejects.toThrow(
      "persistence write failed",
    );
    // The replacement was prepared (CALL #1 succeeded) so it may appear
    // in both snapshot and persisted workspace. The critical contract is:
    // the OLD tab must never be deleted or released when commit fails.
    const snapshot = controller.getSnapshot();
    const persisted = deps.workspace.getWorkspace()!;
    // Old tab ("base") must still be present.
    expect(snapshot.workspace?.tabs.some((tab) => tab.id === "base")).toBe(true);
    expect(persisted.tabs.some((tab) => tab.id === "base")).toBe(true);
    // Base client must not have been released.
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
    // No split: snapshot and persisted workspace agree on tab set.
    expect(snapshot.workspace?.tabs.map((tab) => tab.id).sort()).toEqual(
      persisted.tabs.map((tab) => tab.id).sort(),
    );
  });

  it("keeps the active tab visible when successor prepare succeeds but close commit fails", async () => {
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

  it("lets a newer switch win over an older active close preparation", async () => {
    const successorHistory = deferred<HermesHistoryItem[]>();
    const switchHistory = deferred<HermesHistoryItem[]>();
    let workspace = createConversationWorkspace("base", "base-session");
    workspace = addPendingConversationTab(workspace, "tab-b");
    workspace = replaceConversationSession(workspace, "tab-b", "tab-b-session");
    workspace = addPendingConversationTab(workspace, "tab-c");
    workspace = replaceConversationSession(workspace, "tab-c", "tab-c-session");
    workspace = { ...workspace, activeTabId: "base" };
    const base = fakeClient("base");
    const tabB = fakeClient("tab-b");
    tabB.loadSessionHistory = vi.fn(() => successorHistory.promise);
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

    const closeBase = controller.closeConversation("base");
    const switchToC = controller.switchConversation("tab-c");
    switchHistory.resolve([]);
    await expect(switchToC).resolves.toMatchObject({ tabId: "tab-c" });
    successorHistory.resolve([]);

    await expect(closeBase).rejects.toMatchObject({ code: "cancelled" });
    expect(deps.workspace.getWorkspace()?.activeTabId).toBe("tab-c");
    expect(deps.workspace.getWorkspace()?.tabs.some((tab) => tab.id === "base")).toBe(true);
    expect(deps.clients.releaseClient).not.toHaveBeenCalledWith("base");
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
