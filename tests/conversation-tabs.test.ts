import { describe, expect, it } from "vitest";

import {
  activateConversationTab,
  addPendingConversationTab,
  addConversationTab,
  applyCloseIntent,
  createCloseIntent,
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

  it("removes only the requested middle tab when four conversations are open", () => {
    const workspace = activateConversationTab(
      addConversationTab(
        addConversationTab(
          addConversationTab(createConversationWorkspace("tab-a", "session-a"), "tab-b", "session-b"),
          "tab-c",
          "session-c",
        ),
        "tab-d",
        "session-d",
      ),
      "tab-a",
    );

    const updated = removeConversationTab(workspace, "tab-b");

    expect(updated?.activeTabId).toBe("tab-a");
    expect(updated?.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-c", "tab-d"]);
    expect(updated?.tabs.map((tab) => tab.label)).toEqual([1, 2, 3]);
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

describe("close intent", () => {
  function makeWorkspace(...tabIds: string[]) {
    return tabIds.reduce(
      (ws, id, i) => {
        if (i === 0) return ws;
        return addPendingConversationTab(ws, id);
      },
      createConversationWorkspace(tabIds[0], `${tabIds[0]}-session`),
    );
  }

  it("selects the next neighbor as successor for active close", () => {
    let ws = makeWorkspace("a", "b", "c");
    ws = activateConversationTab(ws, "a");
    const intent = createCloseIntent(ws, "a", () => "replacement");
    expect(intent.closingTabId).toBe("a");
    expect(intent.intendedSuccessorTabId).toBe("b");
    expect(intent.replacementTabId).toBeUndefined();
  });

  it("creates a replacement for the last remaining tab", () => {
    const ws = createConversationWorkspace("only", "only-session");
    let n = 0;
    const intent = createCloseIntent(ws, "only", () => `new-${++n}`);
    expect(intent.intendedSuccessorTabId).toBe("new-1");
    expect(intent.replacementTabId).toBe("new-1");
  });

  it("applyCloseIntent removes the closing tab and activates successor", () => {
    let ws = makeWorkspace("a", "b", "c");
    // Set "a" as active (makeWorkspace left "c" active)
    ws = activateConversationTab(ws, "a");
    const intent = createCloseIntent(ws, "a", () => "replacement");
    const result = applyCloseIntent(ws, intent);
    expect(result.tabs.map((t) => t.id)).toEqual(["b", "c"]);
    expect(result.activeTabId).toBe("b");
  });

  it("preserves user selection when they switched during close", () => {
    let ws = makeWorkspace("a", "b", "c");
    ws = activateConversationTab(ws, "a");
    const intent = createCloseIntent(ws, "a", () => "replacement");
    const latest = activateConversationTab(ws, "c");
    const result = applyCloseIntent(latest, intent);
    expect(result.tabs.map((t) => t.id)).toEqual(["b", "c"]);
    expect(result.activeTabId).toBe("c");
  });

  it("creates replacement and removes old tab atomically", () => {
    const ws = createConversationWorkspace("only", "only-session");
    let n = 0;
    const intent = createCloseIntent(ws, "only", () => `new-${++n}`);
    const result = applyCloseIntent(ws, intent);
    expect(result.tabs.map((t) => t.id)).toEqual(["new-1"]);
    expect(result.activeTabId).toBe("new-1");
  });

  it("throws if closing tab was already removed", () => {
    const ws = makeWorkspace("a", "b");
    const intent = createCloseIntent(ws, "a", () => "replacement");
    const updated = activateConversationTab(
      removeConversationTab(ws, "a")!,
      "b",
    );
    expect(() => applyCloseIntent(updated, intent)).toThrow(
      "already removed",
    );
  });
});

describe("token persistence", () => {
  it("preserves skill token metadata in persisted tab", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const updated = updateConversationTab(workspace, "tab-a", {
      draft: "/skill leader 写任务书",
      includeCurrentDocumentContext: true,
      token: { kind: "skill", name: "leader" },
    });

    expect(updated.tabs[0]).toMatchObject({
      token: { kind: "skill", name: "leader" },
    });
  });

  it("preserves command token metadata in persisted tab", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const updated = updateConversationTab(workspace, "tab-a", {
      draft: "/model grok",
      includeCurrentDocumentContext: true,
      token: { kind: "command", name: "model" },
    });

    expect(updated.tabs[0]).toMatchObject({
      token: { kind: "command", name: "model" },
    });
  });

  it("normalizes old workspace without token field (backward compat)", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "/random ordinary text",
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect(workspace!.tabs[0].draft).toBe("/random ordinary text");
    // Old data without a token field should not have a token
    expect((workspace!.tabs[0] as any).token).toBeUndefined();
  });

  it("safely discards invalid token kind", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "/skill leader 写任务书",
          token: { kind: "invalid", name: "leader" },
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    // invalid kind should be discarded, token field should be undefined
    expect((workspace!.tabs[0] as any).token).toBeUndefined();
  });

  it("safely discards token with empty name", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "/skill leader 写任务书",
          token: { kind: "skill", name: "" },
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    // empty name should be discarded
    expect((workspace!.tabs[0] as any).token).toBeUndefined();
  });

  it.each([
    ["bad name", "skill"],
    ["../leader", "skill"],
    ["/leader", "skill"],
    ["   ", "skill"],
    [" lead:er ", "command"],
    [" leader ", "skill"],
    ["leader", "invalid-kind"],
  ])(
    "discards invalid token metadata (%s) but keeps workspace and draft",
    (name, kind) => {
      const workspace = normalizeConversationWorkspace({
        activeTabId: "tab-a",
        tabs: [
          {
            id: "tab-a",
            label: 1,
            sessionId: "session-a",
            draft: `/skill ${name} task`,
            token: { kind, name },
          },
        ],
        version: 2,
      });

      expect(workspace).toBeDefined();
      expect(workspace!.tabs[0].draft).toBe(`/skill ${name} task`);
      expect((workspace!.tabs[0] as any).token).toBeUndefined();
    },
  );

  it.each([
    ["leader", "skill"],
    ["research-lookup", "skill"],
    ["foo.bar", "command"],
    ["foo_bar", "command"],
  ])("keeps valid token metadata (%s)", (name, kind) => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: `/skill ${name} task`,
          token: { kind, name },
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect((workspace!.tabs[0] as any).token).toEqual({ kind, name });
  });

  it("discards non-string token name", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "/skill leader task",
          token: { kind: "skill", name: 42 },
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect((workspace!.tabs[0] as any).token).toBeUndefined();
  });
});

describe("reference persistence", () => {
  it("preserves reference metadata in a persisted tab patch", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const references = [
      { kind: "url" as const, value: "https://example.com/a" },
      { kind: "path" as const, value: "/Users/中文 空格/笔记.md" },
    ];
    const updated = updateConversationTab(workspace, "tab-a", {
      draft: "https://example.com/a /Users/中文 空格/笔记.md 请总结",
      includeCurrentDocumentContext: true,
      references,
    });

    expect(updated.tabs[0]).toMatchObject({ references });
  });

  it("normalizes workspaces and keeps valid reference metadata", () => {
    const references = [
      { kind: "url", value: "https://example.com/a" },
      { kind: "path", value: "/Users/中文 空格/笔记.md" },
    ];
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "https://example.com/a /Users/中文 空格/笔记.md 请总结",
          references,
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect(workspace!.tabs[0].references).toEqual(references);
    expect(workspace!.tabs[0].draft).toBe(
      "https://example.com/a /Users/中文 空格/笔记.md 请总结",
    );
  });

  it("normalizes old workspaces without a references field (backward compat)", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "https://example.com/a ordinary text",
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect((workspace!.tabs[0] as any).references).toBeUndefined();
  });

  it.each([
    ["not an array", { kind: "url", value: "https://example.com/a" }],
    [
      "bad kind",
      [{ kind: "bookmark", value: "https://example.com/a" }],
    ],
    [
      "empty value",
      [{ kind: "url", value: "" }],
    ],
    [
      "non-string value",
      [{ kind: "url", value: 42 }],
    ],
    [
      "kind/value mismatch",
      [{ kind: "url", value: "/Users/x" }],
    ],
    [
      "untrimmed value",
      [{ kind: "url", value: " https://example.com/a " }],
    ],
  ])(
    "discards invalid reference metadata (%s) but keeps the workspace and draft",
    (_label, references) => {
      const workspace = normalizeConversationWorkspace({
        activeTabId: "tab-a",
        tabs: [
          {
            id: "tab-a",
            label: 1,
            sessionId: "session-a",
            draft: "https://example.com/a 请总结",
            references: references as never,
          },
        ],
        version: 2,
      });

      expect(workspace).toBeDefined();
      expect((workspace!.tabs[0] as any).references).toBeUndefined();
      expect(workspace!.tabs[0].draft).toBe("https://example.com/a 请总结");
    },
  );

  it("round-trips reference metadata through normalize without loss or duplication", () => {
    const references = [
      { kind: "url", value: "https://example.com/once" },
      { kind: "path", value: "/Users/once/路径 空格.md" },
    ];
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: "https://example.com/once /Users/once/路径 空格.md task",
          references,
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect(workspace!.tabs[0].references).toEqual(references);
  });
});

describe("inline reference persistence (start placements)", () => {
  const URL_A = "https://example.com/a";
  const URL_B = "https://example.com/b";

  it("preserves inline reference metadata with UTF-16 starts in a tab patch", () => {
    const workspace = createConversationWorkspace("tab-a", "session-a");
    const references = [
      { kind: "url" as const, value: URL_A, start: 3 },
      { kind: "url" as const, value: URL_B, start: 3 + URL_A.length + 4 },
    ];
    const updated = updateConversationTab(workspace, "tab-a", {
      draft: `先看 ${URL_A}，再看 ${URL_B}`,
      includeCurrentDocumentContext: true,
      references,
    });

    expect(updated.tabs[0]).toMatchObject({
      draft: `先看 ${URL_A}，再看 ${URL_B}`,
      references,
    });
  });

  it("normalizes workspaces keeping inline placements (new schema)", () => {
    const references = [
      { kind: "url" as const, value: URL_A, start: 2 },
    ];
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: `前文${URL_A}后文`,
          references,
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect(workspace!.tabs[0].references).toEqual(references);
  });

  it("round-trips inline placements through normalize for multiple tabs", () => {
    const first: Array<{ kind: "url"; value: string; start: number }> = [
      { kind: "url", value: URL_A, start: 0 },
    ];
    const second: Array<{ kind: "url"; value: string; start: number }> = [
      { kind: "url", value: URL_B, start: 4 },
    ];
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-b",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: URL_A,
          references: first,
        },
        {
          id: "tab-b",
          label: 2,
          sessionId: "session-b",
          draft: `正文${URL_B}`,
          references: second,
        },
      ],
      version: 2,
    });

    expect(workspace!.tabs[0].references).toEqual(first);
    expect(workspace!.tabs[1].references).toEqual(second);
  });

  it("discards references with malformed starts but keeps the workspace and draft", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: `前文${URL_A}后文`,
          references: [{ kind: "url", value: URL_A, start: "broken" }],
        },
      ],
      version: 2,
    });

    expect(workspace).toBeDefined();
    expect((workspace!.tabs[0] as any).references).toBeUndefined();
    expect(workspace!.tabs[0].draft).toBe(`前文${URL_A}后文`);
  });

  it("keeps legacy metadata without starts readable alongside new-schema data", () => {
    const workspace = normalizeConversationWorkspace({
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          label: 1,
          sessionId: "session-a",
          draft: `${URL_A} task`,
          references: [{ kind: "url", value: URL_A }],
        },
      ],
      version: 2,
    });

    expect(workspace!.tabs[0].references).toEqual([
      { kind: "url", value: URL_A },
    ]);
  });
});
