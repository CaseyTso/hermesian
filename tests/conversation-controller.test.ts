import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationController,
  type ConversationClient,
  type ConversationControllerDependencies,
} from "../src/conversation-controller";
import { createConversationWorkspace } from "../src/conversation-tabs";

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
  workspace: ReturnType<typeof createConversationWorkspace>,
  client: FakeClient,
): ConversationControllerDependencies<FakeClient> {
  return {
    clients: {
      acquireClient: vi.fn(() => client),
      getClient: vi.fn(() => client),
      isCurrentClient: vi.fn(() => true),
      releaseClient: vi.fn(async () => undefined),
    },
    workspace: {
      getWorkspace: vi.fn(() => workspace),
      setWorkspace: vi.fn(),
    },
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
    connect.resolve();
    await connect.promise;
    expect(client.connect).not.toHaveBeenCalled();
  });
});
