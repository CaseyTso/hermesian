import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationController,
  type ConversationClient,
  type ConversationControllerDependencies,
} from "../src/conversation-controller";
import { createConversationWorkspace } from "../src/conversation-tabs";
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
    createTabId: () => client.id,
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
