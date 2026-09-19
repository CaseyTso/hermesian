import { describe, expect, it, vi } from "vitest";
import { ConversationController, type ConversationClient } from "../src/conversation-controller";
import { createConversationWorkspace, addConversationTab, updateConversationTab } from "../src/conversation-tabs";
import type { HermesHistoryItem } from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(ids = ["a", "b", "c"]) {
  let workspace = createConversationWorkspace(ids[0]!, `session-${ids[0]}`);
  for (const id of ids.slice(1)) workspace = addConversationTab(workspace, id, `session-${id}`);
  workspace.activeTabId = ids[0]!;
  workspace = updateConversationTab(workspace, ids[0]!, { draft: "keep draft", includeCurrentDocumentContext: false });
  const calls: string[] = [];
  const gates = new Map(ids.map((id) => [id, deferred<HermesHistoryItem[]>()]));
  const clients = new Map<string, ConversationClient>();
  for (const id of ids) {
    const client: ConversationClient = {
      connect: vi.fn(async () => { client.sessionId = `fresh-${id}`; }),
      disconnect: vi.fn(async () => undefined),
      newSession: vi.fn(async () => undefined),
      loadSessionHistory: vi.fn(async (sessionId) => {
        calls.push(id);
        const items = await gates.get(id)!.promise;
        client.sessionId = sessionId;
        return items;
      }),
    };
    clients.set(id, client);
  }
  const local = vi.fn(async (sessionId: string): Promise<HermesHistoryItem[]> => [{ kind: "user", text: `local-${sessionId}` }]);
  const deps = {
    clients: {
      acquireClient: (id: string) => clients.get(id)!,
      getClient: (id: string) => clients.get(id),
      isCurrentClient: (id: string, client: ConversationClient) => clients.get(id) === client,
      releaseClient: vi.fn(async (id: string) => { clients.delete(id); }),
    },
    createTabId: () => "reopened",
    readLocalHistory: local,
    workspace: {
      getWorkspace: () => workspace,
      setWorkspace: vi.fn((next: typeof workspace) => { workspace = next; }),
    },
  };
  const controller = new ConversationController(deps);
  return { controller, deps, clients, gates, calls, local };
}

describe("conversation readiness milestone", () => {
  it("publishes editable saved drafts and local history before any ACP initialization", async () => {
    const h = harness();
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.workspace?.tabs).toHaveLength(3);
    expect(snapshot.workspace?.tabs[0]?.draft).toBe("keep draft");
    expect(snapshot.controls.active).toMatchObject({ composer: true, send: true, hasSession: false, model: false, history: false, restart: false });
    await h.controller.readWorkspaceHistory();
    expect(h.calls).toEqual([]);
    expect(h.controller.getSnapshot().histories.get("a")?.items).toEqual([{ kind: "user", text: "local-session-a" }]);
    expect(h.controller.getSnapshot().controls.active.hasSession).toBe(false);
  });

  it("restores active first, promotes a selected queued tab, and deduplicates every caller", async () => {
    const h = harness();
    const initializing = h.controller.initialize();
    expect(h.calls).toEqual(["a"]);
    const c1 = h.controller.ensureConversationReady("c");
    const c2 = h.controller.ensureConversationReady("c");
    expect(c1).toBe(c2);
    await h.controller.switchConversation("c");
    expect(h.controller.getSnapshot().workspace?.activeTabId).toBe("c");
    expect(h.controller.getSnapshot().controls.active.composer).toBe(true);
    h.gates.get("a")!.resolve([]);
    await initializing;
    expect(h.calls).toEqual(["a", "c"]);
    h.gates.get("c")!.resolve([]);
    await c1;
    await tick();
    expect(h.calls).toEqual(["a", "c", "b"]);
    h.gates.get("b")!.resolve([]);
    await h.controller.ensureConversationReady("b");
    expect(h.clients.get("c")!.loadSessionHistory).toHaveBeenCalledOnce();
  });

  it("does not globally block foreground operations while a background restore waits or fails", async () => {
    const h = harness(["a", "b"]);
    const initializing = h.controller.initialize();
    h.gates.get("a")!.resolve([]);
    await initializing;
    expect(h.calls).toEqual(["a", "b"]);
    expect(h.controller.getSnapshot().controls.active).toMatchObject({ send: true, model: true, history: true, composer: true });
    // Thinking/settings are per-tab in milestone 2: background restore does not lock reasoning.
    expect(h.controller.getSnapshot().controls.aggregate.reasoning).toBe(true);
    h.gates.get("b")!.reject(new Error("offline"));
    await tick();
    expect(h.controller.getSnapshot().tabOperations.get("b")?.connection).toBe("failed");
    expect(h.controller.getSnapshot().controls.active.send).toBe(true);
    expect(h.calls).toEqual(["a", "b"]); // no automatic retry
  });

  it("retains failed session, draft, references and local history, then retries only on request", async () => {
    const h = harness(["a"]);
    const client = h.clients.get("a")!;
    const initializing = h.controller.initialize();
    await tick();
    h.gates.get("a")!.reject(new Error("missing"));
    await expect(initializing).rejects.toThrow("missing");
    expect(client.newSession).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().workspace?.tabs[0]).toMatchObject({ sessionId: "session-a", draft: "keep draft" });
    expect(h.controller.getSnapshot().histories.get("a")?.source).toBe("local");
    expect(h.controller.getSnapshot().controls.active.composer).toBe(true);
    const retry = deferred<HermesHistoryItem[]>();
    h.gates.set("a", retry);
    const ready = h.controller.ensureConversationReady("a");
    retry.resolve([{ kind: "assistant", text: "authoritative" }]);
    await ready;
    expect(h.calls).toEqual(["a", "a"]);
    expect(h.controller.getSnapshot().histories.get("a")?.source).toBe("acp");
  });

  it("ignores a late local history read after ACP has supplied authoritative history", async () => {
    const h = harness(["a"]);
    const local = deferred<HermesHistoryItem[]>();
    h.local.mockReturnValue(local.promise);
    const initializing = h.controller.initialize();
    h.gates.get("a")!.resolve([{ kind: "assistant", text: "ACP" }]);
    await initializing;
    local.resolve([{ kind: "user", text: "stale" }]);
    await tick();
    expect(h.controller.getSnapshot().histories.get("a")?.items).toEqual([{ kind: "assistant", text: "ACP" }]);
  });

  it("closing a loading tab invalidates its result and reopening the same session cannot inherit it", async () => {
    const h = harness(["a", "b"]);
    const initializing = h.controller.initialize();
    const rejected = expect(initializing).rejects.toMatchObject({ code: "operation_stale" });
    await h.controller.closeConversation("a");
    const reopened: ConversationClient = {
      sessionId: "session-a", connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      newSession: vi.fn(async () => undefined), loadSessionHistory: vi.fn(async () => [{ kind: "user" as const, text: "reopened" }]),
    };
    h.clients.set("reopened", reopened);
    const opening = h.controller.openHistorySession("session-a");
    h.gates.get("a")!.resolve([{ kind: "user", text: "stale closed" }]);
    await rejected;
    await opening;
    expect(h.controller.getSnapshot().workspace?.tabs.some((tab) => tab.id === "a")).toBe(false);
    expect(h.controller.getSnapshot().histories.has("a")).toBe(false);
    expect(h.controller.getSnapshot().histories.get("reopened")?.items).toEqual([{ kind: "user", text: "reopened" }]);
    h.gates.get("b")!.resolve([]);
  });

  it("closing a queued tab prevents its client from ever being acquired", async () => {
    const h = harness();
    const initializing = h.controller.initialize();
    await h.controller.closeConversation("c");
    h.gates.get("a")!.resolve([]);
    await initializing;
    h.gates.get("b")!.resolve([]);
    await tick();
    expect(h.calls).toEqual(["a", "b"]);
  });

  it("shutdown rejects queued requests and drops in-flight readiness without publishing history", async () => {
    const h = harness();
    const initializing = h.controller.initialize();
    const initRejected = expect(initializing).rejects.toMatchObject({ code: "cancelled" });
    const queued = h.controller.ensureConversationReady("c");
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: "cancelled" });
    await h.controller.shutdown();
    h.gates.get("a")!.resolve([{ kind: "assistant", text: "late" }]);
    await Promise.all([initRejected, queuedRejected]);
    expect(h.controller.getSnapshot().histories.size).toBe(0);
    expect(h.calls).toEqual(["a"]);
  });

  it("does not overwrite edits or navigation made during hydration", async () => {
    const h = harness(["a", "b"]);
    const initializing = h.controller.initialize();
    const edited = updateConversationTab(h.deps.workspace.getWorkspace(), "a", { draft: "typed while loading", includeCurrentDocumentContext: false });
    h.deps.workspace.setWorkspace(edited);
    await h.controller.switchConversation("b");
    h.gates.get("a")!.resolve([]);
    await initializing;
    expect(h.controller.getSnapshot().workspace?.activeTabId).toBe("b");
    expect(h.controller.getSnapshot().workspace?.tabs[0]?.draft).toBe("typed while loading");
    h.gates.get("b")!.resolve([]);
  });
});
