import { describe, expect, it } from "vitest";

import {
  activateConversationTab,
  addPendingConversationTab,
  addConversationTab,
  ConversationTransitionCoordinator,
  conversationControlAvailability,
  conversationControlsBusy,
  createConversationWorkspace,
  isActiveConversationSession,
  normalizeConversationWorkspace,
  removeConversationTab,
  replaceConversationSession,
  shouldAutoScrollConversation,
  updateConversationTab,
} from "../src/conversation-tabs";

describe("conversation workspace", () => {
  it("creates an initial persisted tab", () => {
    expect(createConversationWorkspace("tab-a", "session-a")).toEqual({
      activeTabId: "tab-a",
      nextLabel: 2,
      tabs: [
        {
          draft: "",
          id: "tab-a",
          includeCurrentDocumentContext: true,
          label: 1,
          sessionId: "session-a",
        },
      ],
      version: 2,
    });
  });

  it("adds and activates tabs with sequential labels", () => {
    const initial = createConversationWorkspace("tab-a", "session-a");
    const second = addConversationTab(initial, "tab-b", "session-b");
    const inactive = activateConversationTab(second, "tab-a");
    const third = addConversationTab(inactive, "tab-c", "session-c");

    expect(second.activeTabId).toBe("tab-b");
    expect(third.activeTabId).toBe("tab-c");
    expect(third.tabs.map((tab) => tab.label)).toEqual([1, 2, 3]);
    expect(third.nextLabel).toBe(4);
  });

  it("adds an active deferred tab without inventing a Hermes session", () => {
    const initial = createConversationWorkspace("tab-a", "session-a");
    const pending = addPendingConversationTab(initial, "tab-b");

    expect(pending.activeTabId).toBe("tab-b");
    expect(pending.tabs[1]).toMatchObject({
      draft: "",
      id: "tab-b",
      label: 2,
      sessionId: null,
    });
  });

  it("binds a deferred tab without losing its draft", () => {
    const pending = updateConversationTab(
      addPendingConversationTab(
        createConversationWorkspace("tab-a", "session-a"),
        "tab-b",
      ),
      "tab-b",
      { draft: "write this later", includeCurrentDocumentContext: false },
    );

    expect(replaceConversationSession(pending, "tab-b", "session-b").tabs[1]).toEqual({
      draft: "write this later",
      id: "tab-b",
      includeCurrentDocumentContext: false,
      label: 2,
      sessionId: "session-b",
    });
  });

  it("updates only the requested tab runtime fields", () => {
    const workspace = addConversationTab(
      createConversationWorkspace("tab-a", "session-a"),
      "tab-b",
      "session-b",
    );
    const updated = updateConversationTab(workspace, "tab-a", {
      draft: "unfinished message",
      includeCurrentDocumentContext: false,
    });

    expect(updated.tabs[0]).toMatchObject({
      draft: "unfinished message",
      includeCurrentDocumentContext: false,
      sessionId: "session-a",
    });
    expect(updated.tabs[1]).toEqual(workspace.tabs[1]);
  });

  it("replaces a tab session without changing its identity", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const updated = replaceConversationSession(workspace, "tab-a", "session-new");

    expect(updated.tabs[0]).toMatchObject({
      id: "tab-a",
      label: 1,
      sessionId: "session-new",
    });
  });

  it("rejects binding one Hermes session to two tabs", () => {
    const workspace = addConversationTab(
      createConversationWorkspace("tab-a", "session-a"),
      "tab-b",
      "session-b",
    );

    expect(() => replaceConversationSession(workspace, "tab-b", "session-a")).toThrow(
      "already open",
    );
  });

  it("checks the active tab and session together after async preparation", () => {
    const workspace = addConversationTab(
      createConversationWorkspace("tab-a", "session-a"),
      "tab-b",
      "session-b",
    );

    expect(isActiveConversationSession(workspace, "tab-b", "session-b")).toBe(true);
    expect(isActiveConversationSession(workspace, "tab-a", "session-a")).toBe(false);
    expect(isActiveConversationSession(workspace, "tab-b", "session-a")).toBe(false);
  });

  it("removes an inactive tab without changing the active tab", () => {
    const workspace = activateConversationTab(
      addConversationTab(
        createConversationWorkspace("tab-a", "session-a"),
        "tab-b",
        "session-b",
      ),
      "tab-a",
    );

    expect(removeConversationTab(workspace, "tab-b")).toEqual({
      ...workspace,
      nextLabel: 2,
      tabs: [workspace.tabs[0]],
    });
  });

  it("activates the right neighbor when removing the active tab", () => {
    const first = createConversationWorkspace("tab-a", "session-a");
    const second = addConversationTab(first, "tab-b", "session-b");
    const third = addConversationTab(second, "tab-c", "session-c");
    const workspace = activateConversationTab(third, "tab-b");

    const updated = removeConversationTab(workspace, "tab-b");

    expect(updated?.activeTabId).toBe("tab-c");
    expect(updated?.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-c"]);
    expect(updated?.tabs.map((tab) => tab.label)).toEqual([1, 2]);
    expect(updated?.nextLabel).toBe(3);
  });

  it("activates the left neighbor when removing the last active tab", () => {
    const workspace = addConversationTab(
      createConversationWorkspace("tab-a", "session-a"),
      "tab-b",
      "session-b",
    );

    expect(removeConversationTab(workspace, "tab-b")?.activeTabId).toBe("tab-a");
  });

  it("returns undefined when removing the only tab", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");

    expect(removeConversationTab(workspace, "tab-a")).toBeUndefined();
  });

  it("reuses compact sequential labels after repeated closes and additions", () => {
    const third = addConversationTab(
      addConversationTab(
        createConversationWorkspace("tab-a", "session-a"),
        "tab-b",
        "session-b",
      ),
      "tab-c",
      "session-c",
    );
    const withoutFirst = removeConversationTab(third, "tab-a");
    const onlyThird = withoutFirst && removeConversationTab(withoutFirst, "tab-b");
    const fourth = onlyThird && addConversationTab(onlyThird, "tab-d", "session-d");
    const withoutFourth = fourth && removeConversationTab(fourth, "tab-d");
    const fifth = withoutFourth && addConversationTab(withoutFourth, "tab-e", "session-e");

    expect(fifth?.tabs.map((tab) => ({ id: tab.id, label: tab.label }))).toEqual([
      { id: "tab-c", label: 1 },
      { id: "tab-e", label: 2 },
    ]);
    expect(fifth?.nextLabel).toBe(3);
  });
});

describe("ConversationTransitionCoordinator", () => {
  it("invalidates an in-flight switch when another transition takes ownership", () => {
    const coordinator = new ConversationTransitionCoordinator();
    const generation = coordinator.beginSwitch();

    expect(coordinator.isCurrentSwitch(generation)).toBe(true);
    coordinator.invalidateSwitch();
    expect(coordinator.isCurrentSwitch(generation)).toBe(false);
  });

  it("reserves a session for only one tab until its operation finishes", () => {
    const coordinator = new ConversationTransitionCoordinator();

    expect(coordinator.reserveSession("tab-a", "session-x")).toBe(true);
    expect(coordinator.reserveSession("tab-b", "session-x")).toBe(false);
    coordinator.releaseSession("tab-b", "session-x");
    expect(coordinator.reserveSession("tab-b", "session-x")).toBe(false);
    coordinator.releaseSession("tab-a", "session-x");
    expect(coordinator.reserveSession("tab-b", "session-x")).toBe(true);
  });
});

describe("conversationControlAvailability", () => {
  const idle = {
    activeTabBusy: false,
    activeTabLoading: false,
    activeTabPermissionPending: false,
    anyTabBusy: false,
    anyTabLoading: false,
    anyPermissionPending: false,
    controlsBusy: false,
    hasSession: true,
    initializing: false,
    switchingModel: false,
  };

  it("keeps an idle active tab sendable while another tab responds", () => {
    expect(
      conversationControlAvailability({ ...idle, anyTabBusy: true }),
    ).toMatchObject({
      add: true,
      composer: true,
      history: true,
      model: true,
      reasoning: false,
      send: true,
      stop: false,
    });
  });

  it("shows Stop and disables Send only for the responding active tab", () => {
    expect(
      conversationControlAvailability({
        ...idle,
        activeTabBusy: true,
        anyTabBusy: true,
      }),
    ).toMatchObject({ composer: false, send: false, stop: true });
  });

  it("allows drafting while a new tab starts but waits for its session before send", () => {
    expect(
      conversationControlAvailability({
        ...idle,
        activeTabLoading: true,
        anyTabLoading: true,
        hasSession: false,
      }),
    ).toMatchObject({ add: true, composer: true, send: false });
  });

  it("blocks only the active tab composer for permission and all controls for init", () => {
    expect(
      conversationControlAvailability({
        ...idle,
        activeTabPermissionPending: true,
        anyPermissionPending: true,
      }),
    ).toMatchObject({ add: true, composer: false, send: false });
    expect(
      conversationControlAvailability({ ...idle, initializing: true }),
    ).toMatchObject({ add: false, composer: false, send: false });
  });
});

describe("conversationControlsBusy", () => {
  it("keeps controls locked until initialization finishes", () => {
    expect(conversationControlsBusy(false, true)).toBe(true);
    expect(conversationControlsBusy(true, false)).toBe(true);
    expect(conversationControlsBusy(false, false)).toBe(false);
  });
});

describe("shouldAutoScrollConversation", () => {
  it("does not scroll the visible tab for updates from a hidden working tab", () => {
    expect(shouldAutoScrollConversation("tab-b", "tab-a")).toBe(false);
  });

  it("scrolls visible-tab updates and unscoped rendering", () => {
    expect(shouldAutoScrollConversation("tab-a", "tab-a")).toBe(true);
    expect(shouldAutoScrollConversation("tab-a", undefined)).toBe(true);
  });
});

describe("normalizeConversationWorkspace", () => {
  it("migrates v1 labels into sequential v2 state", () => {
    expect(
      normalizeConversationWorkspace({
        activeTabId: "tab-b",
        nextLabel: 6,
        tabs: [
          {
            draft: "one",
            id: "tab-a",
            includeCurrentDocumentContext: false,
            label: 3,
            sessionId: "session-a",
          },
          {
            id: "tab-b",
            label: 5,
            sessionId: "session-b",
          },
        ],
        version: 1,
      }),
    ).toEqual({
      activeTabId: "tab-b",
      nextLabel: 3,
      tabs: [
        {
          draft: "one",
          id: "tab-a",
          includeCurrentDocumentContext: false,
          label: 1,
          sessionId: "session-a",
        },
        {
          draft: "",
          id: "tab-b",
          includeCurrentDocumentContext: true,
          label: 2,
          sessionId: "session-b",
        },
      ],
      version: 2,
    });
  });

  it("preserves deferred tabs in schema v2", () => {
    expect(
      normalizeConversationWorkspace({
        activeTabId: "tab-b",
        nextLabel: 3,
        tabs: [
          { id: "tab-a", label: 1, sessionId: "session-a" },
          { draft: "later", id: "tab-b", label: 2, sessionId: null },
        ],
        version: 2,
      }),
    ).toMatchObject({
      activeTabId: "tab-b",
      tabs: [
        { id: "tab-a", sessionId: "session-a" },
        { draft: "later", id: "tab-b", sessionId: null },
      ],
      version: 2,
    });
  });

  it("keeps one owner and unbinds duplicate persisted session IDs", () => {
    expect(
      normalizeConversationWorkspace({
        activeTabId: "tab-b",
        tabs: [
          { id: "tab-a", label: 1, sessionId: "same-session" },
          { id: "tab-b", label: 2, sessionId: "same-session" },
        ],
        version: 2,
      })?.tabs.map((tab) => tab.sessionId),
    ).toEqual(["same-session", null]);
  });

  it.each([
    null,
    {},
    { version: 2, tabs: [] },
    {
      activeTabId: "missing",
      nextLabel: 2,
      tabs: [{ id: "tab-a", label: 1, sessionId: "session-a" }],
      version: 1,
    },
    {
      activeTabId: "tab-a",
      nextLabel: 3,
      tabs: [
        { id: "tab-a", label: 1, sessionId: "session-a" },
        { id: "tab-a", label: 2, sessionId: "session-b" },
      ],
      version: 1,
    },
    {
      activeTabId: "tab-a",
      nextLabel: 2,
      tabs: [{ id: "tab-a", label: 1, sessionId: "" }],
      version: 1,
    },
    {
      activeTabId: "tab-a",
      nextLabel: 2,
      tabs: [{ id: "tab-a", label: 1, sessionId: null }],
      version: 1,
    },
    {
      activeTabId: "tab-a",
      nextLabel: 2,
      tabs: [{ id: "tab-a", label: 1, sessionId: "session-a" }],
      version: 3,
    },
  ])("rejects invalid persisted data %#", (value) => {
    expect(normalizeConversationWorkspace(value)).toBeUndefined();
  });
});
