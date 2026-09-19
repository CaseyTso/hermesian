import { describe, expect, it } from "vitest";
import { ConversationController } from "../src/conversation-controller";

import {
  addConversationTab,
  addPendingConversationTab,
  applyCloseIntent,
  createCloseIntent,
  createConversationWorkspace,
  normalizeConversationWorkspace,
  updateConversationTab,
} from "../src/conversation-tabs";

describe("reasoning effort persistence, migration, and inheritance", () => {
  it("seeds an empty controller from the plugin default before initialization", () => {
    const controller = new ConversationController({
      defaultReasoningEffort: () => "high", createTabId: () => "initial",
      workspace: { getWorkspace: () => undefined, setWorkspace: () => {} },
      clients: { acquireClient: () => { throw new Error("must not connect"); },
        getClient: () => undefined, isCurrentClient: () => false, releaseClient: async () => {} },
    });
    const workspace = controller.getSnapshot().workspace!;
    expect(workspace.tabs[0].reasoningEffort).toBe("high");
    expect(addPendingConversationTab(workspace, "second").tabs[1].reasoningEffort).toBe("high");
  });

  it("initializes tab with default reasoning effort", () => {
    const ws = createConversationWorkspace("tab-1", "sess-1");
    expect(ws.tabs[0].reasoningEffort).toBe("default");
  });

  it("initializes tab with explicit reasoning effort", () => {
    const ws = createConversationWorkspace("tab-1", "sess-1", "high");
    expect(ws.tabs[0].reasoningEffort).toBe("high");
  });

  it("inherits reasoning effort from the active tab when creating new tabs", () => {
    const initial = createConversationWorkspace("tab-1", "sess-1", "high");
    const withSecond = addConversationTab(initial, "tab-2", "sess-2");

    expect(withSecond.tabs[1].reasoningEffort).toBe("high");

    // Change tab 2 to 'low' and activate it
    const updated = updateConversationTab(withSecond, "tab-2", { reasoningEffort: "low" });
    const withThird = addConversationTab(updated, "tab-3", "sess-3");

    expect(withThird.tabs[2].reasoningEffort).toBe("low");
  });

  it("inherits reasoning effort from the active tab when creating pending tabs", () => {
    const initial = createConversationWorkspace("tab-1", "sess-1", "medium");
    const pending = addPendingConversationTab(initial, "tab-2");

    expect(pending.tabs[1].reasoningEffort).toBe("medium");
  });

  it("migrates legacy workspace tabs using provided fallback reasoning effort", () => {
    const legacyWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 3,
      tabs: [
        {
          draft: "hello",
          id: "tab-1",
          includeCurrentDocumentContext: true,
          label: 1,
          sessionId: "sess-1",
        },
        {
          draft: "world",
          id: "tab-2",
          includeCurrentDocumentContext: false,
          label: 2,
          sessionId: "sess-2",
        },
      ],
      version: 2,
    };

    const normalized = normalizeConversationWorkspace(legacyWorkspace, "xhigh");
    expect(normalized).toBeDefined();
    expect(normalized?.tabs[0].reasoningEffort).toBe("xhigh");
    expect(normalized?.tabs[1].reasoningEffort).toBe("xhigh");
  });

  it("preserves existing reasoning effort while migrating missing ones", () => {
    const mixedWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 3,
      tabs: [
        {
          id: "tab-1",
          label: 1,
          reasoningEffort: "ultra",
          sessionId: "sess-1",
        },
        {
          id: "tab-2",
          label: 2,
          sessionId: "sess-2",
        },
      ],
      version: 2,
    };

    const normalized = normalizeConversationWorkspace(mixedWorkspace, "low");
    expect(normalized).toBeDefined();
    expect(normalized?.tabs[0].reasoningEffort).toBe("ultra");
    expect(normalized?.tabs[1].reasoningEffort).toBe("low");
  });

  it("replaces invalid reasoning effort with fallback during normalization", () => {
    const badWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 2,
      tabs: [
        {
          id: "tab-1",
          label: 1,
          reasoningEffort: "non_existent_effort",
          sessionId: "sess-1",
        },
      ],
      version: 2,
    };

    const normalized = normalizeConversationWorkspace(badWorkspace, "medium");
    expect(normalized?.tabs[0].reasoningEffort).toBe("medium");
  });

  it("updates reasoning effort only for the targeted tab", () => {
    let ws = createConversationWorkspace("tab-1", "sess-1", "low");
    ws = addConversationTab(ws, "tab-2", "sess-2", "medium");
    ws = addConversationTab(ws, "tab-3", "sess-3", "high");

    const updated = updateConversationTab(ws, "tab-2", { reasoningEffort: "ultra" });

    expect(updated.tabs.find((t) => t.id === "tab-1")?.reasoningEffort).toBe("low");
    expect(updated.tabs.find((t) => t.id === "tab-2")?.reasoningEffort).toBe("ultra");
    expect(updated.tabs.find((t) => t.id === "tab-3")?.reasoningEffort).toBe("high");
  });

  it("preserves closing tab's reasoning effort in replacement tab when last tab is closed", () => {
    const ws = createConversationWorkspace("tab-1", "sess-1", "xhigh");
    const intent = createCloseIntent(ws, "tab-1", () => "tab-replacement");
    const result = applyCloseIntent(ws, intent);

    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].id).toBe("tab-replacement");
    expect(result.tabs[0].reasoningEffort).toBe("xhigh");
  });
});
