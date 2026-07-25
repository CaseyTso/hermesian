import { describe, expect, it } from "vitest";

import {
  ConversationOperationCoordinator,
  deriveConversationControlAvailability,
  deriveConversationControls,
  removeTabOperation,
  type ConversationRuntimeState,
  type TabOperationState,
} from "../src/conversation-runtime";

function tabState(
  overrides: Partial<TabOperationState> = {},
): TabOperationState {
  return {
    closing: false,
    connection: "ready",
    hasSession: true,
    permissionPending: false,
    prompt: "idle",
    sessionOperation: "idle",
    ...overrides,
  };
}

function runtimeState(
  tabs: ReadonlyMap<string, TabOperationState>,
  overrides: Partial<ConversationRuntimeState> = {},
): ConversationRuntimeState {
  return {
    activeTabId: "tab-b",
    globalOperation: "idle",
    initializing: false,
    tabs,
    ...overrides,
  };
}

describe("conversation runtime control availability", () => {
  it("keeps every session-mutating control disabled during initialization", () => {
    const availability = deriveConversationControlAvailability(
      runtimeState(
        new Map([["tab-a", tabState()], ["tab-b", tabState()]]),
        { initializing: true },
      ),
    );

    expect(availability).toMatchObject({
      add: false,
      close: false,
      composer: false,
      history: false,
      model: false,
      reasoning: false,
      send: false,
      stop: false,
      tabNavigation: false,
    });
  });

  it("keeps idle tab B usable while tab A is prompting", () => {
    const availability = deriveConversationControlAvailability(
      runtimeState(
        new Map([
          ["tab-a", tabState({ prompt: "running" })],
          ["tab-b", tabState()],
        ]),
      ),
    );

    expect(availability).toMatchObject({
      add: true,
      close: true,
      composer: true,
      history: true,
      model: true,
      reasoning: false,
      send: true,
      stop: false,
      tabNavigation: true,
    });
  });

  it("shows Stop and blocks session mutation only for the active prompting tab", () => {
    const availability = deriveConversationControlAvailability(
      runtimeState(
        new Map([
          ["tab-a", tabState()],
          ["tab-b", tabState({ prompt: "running" })],
        ]),
      ),
    );

    expect(availability).toMatchObject({
      add: true,
      close: false,
      composer: false,
      history: false,
      model: false,
      reasoning: false,
      send: false,
      stop: true,
      tabNavigation: true,
    });
  });

  it("allows drafting in a loading or deferred tab but not sending", () => {
    const availability = deriveConversationControlAvailability(
      runtimeState(
        new Map([
          [
            "tab-b",
            tabState({ connection: "loading", hasSession: false }),
          ],
        ]),
      ),
    );

    expect(availability).toMatchObject({
      composer: true,
      history: false,
      model: false,
      send: false,
      stop: false,
    });
  });

  it("does not globally block an idle tab close while another tab is loading", () => {
    const availability = deriveConversationControlAvailability(
      runtimeState(
        new Map([
          ["tab-a", tabState({ connection: "loading", hasSession: false })],
          ["tab-b", tabState()],
        ]),
      ),
    );

    expect(availability).toMatchObject({
      add: true,
      close: true,
      composer: true,
      history: true,
      model: true,
      reasoning: false,
      send: true,
      tabNavigation: true,
    });
  });

  it("locks only the permission owner while keeping global settings disabled", () => {
    const tabs = new Map([
      ["tab-a", tabState({ permissionPending: true })],
      ["tab-b", tabState()],
    ]);

    expect(deriveConversationControlAvailability(runtimeState(tabs), "tab-a")).toMatchObject({
      close: false,
      history: false,
      model: false,
      send: false,
      reasoning: false,
    });
    expect(deriveConversationControlAvailability(runtimeState(tabs), "tab-b")).toMatchObject({
      close: true,
      history: true,
      model: true,
      send: true,
      reasoning: false,
    });
  });

  it("locks only a tab whose session operation or close is in flight", () => {
    const availability = deriveConversationControlAvailability(
      runtimeState(
        new Map([
          ["tab-a", tabState({ sessionOperation: "load" })],
          ["tab-b", tabState()],
        ]),
        { activeTabId: "tab-a" },
      ),
    );

    expect(availability).toMatchObject({
      close: false,
      composer: false,
      history: false,
      model: false,
      send: false,
      stop: false,
      tabNavigation: true,
    });
    expect(
      deriveConversationControlAvailability(
        runtimeState(
          new Map([
            ["tab-a", tabState({ closing: true })],
            ["tab-b", tabState()],
          ]),
          { activeTabId: "tab-a" },
        ),
      ).close,
    ).toBe(false);
  });

  it("uses the same Send decision for keyboard and button guards", () => {
    const state = runtimeState(
      new Map([["tab-b", tabState()]]),
    );
    const availability = deriveConversationControlAvailability(state);

    expect(availability.send).toBe(availability.composer && availability.hasSession);
  });

  it("publishes aggregate and per-tab controls from one runtime state", () => {
    const controls = deriveConversationControls(
      runtimeState(
        new Map([
          ["tab-a", tabState({ prompt: "running" })],
          ["tab-b", tabState()],
        ]),
      ),
    );

    expect(controls.byTab.get("tab-a")).toMatchObject({
      composer: false,
      send: false,
      stop: true,
    });
    expect(controls.byTab.get("tab-b")).toMatchObject({
      composer: true,
      send: true,
      stop: false,
    });
    expect(controls.active).toBe(controls.byTab.get("tab-b"));
    expect(controls.aggregate).toEqual({
      connectionSettings: false,
      reasoning: false,
      tabNavigation: true,
    });
  });

  it("keeps permission controls target-scoped while blocking global navigation", () => {
    const controls = deriveConversationControls(
      runtimeState(
        new Map([
          ["tab-a", tabState({ permissionPending: true })],
          ["tab-b", tabState()],
        ]),
      ),
    );

    expect(controls.byTab.get("tab-a")).toMatchObject({
      composer: false,
      send: false,
    });
    expect(controls.byTab.get("tab-b")).toMatchObject({
      composer: true,
      send: true,
    });
    expect(controls.aggregate).toEqual({
      connectionSettings: false,
      reasoning: false,
      tabNavigation: false,
    });
  });
});

describe("conversation runtime operation ownership", () => {
  it("does not let an older operation clear a newer operation on the same tab", () => {
    const coordinator = new ConversationOperationCoordinator();
    const first = coordinator.begin("tab-a");
    const second = coordinator.begin("tab-a");

    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);

    coordinator.complete(first);
    expect(coordinator.isCurrent(second)).toBe(true);

    coordinator.complete(second);
    expect(coordinator.isCurrent(second)).toBe(false);
  });

  it("keeps operation ownership independent for different tabs", () => {
    const coordinator = new ConversationOperationCoordinator();
    const tabA = coordinator.begin("tab-a");
    const tabB = coordinator.begin("tab-b");

    expect(coordinator.isCurrent(tabA)).toBe(true);
    expect(coordinator.isCurrent(tabB)).toBe(true);
  });

  it("invalidates a pending transition generation", () => {
    const coordinator = new ConversationOperationCoordinator();
    const firstGeneration = coordinator.beginTransition();

    expect(coordinator.isCurrentTransition(firstGeneration)).toBe(true);
    coordinator.invalidateTransition();
    expect(coordinator.isCurrentTransition(firstGeneration)).toBe(false);

    const secondGeneration = coordinator.beginTransition();
    expect(coordinator.isCurrentTransition(secondGeneration)).toBe(true);
  });

  it("invalidates a switch even when the permission owner is already active", () => {
    const coordinator = new ConversationOperationCoordinator();
    const generation = coordinator.beginTransition();

    coordinator.invalidateTransition();

    expect(coordinator.isCurrentTransition(generation)).toBe(false);
  });

  it("removes only the closed tab runtime state", () => {
    const state = runtimeState(
      new Map([
        ["tab-a", tabState()],
        ["tab-b", tabState({ prompt: "running" })],
      ]),
      { activeTabId: "tab-b" },
    );

    const updated = removeTabOperation(state, "tab-a");

    expect(updated.tabs.has("tab-a")).toBe(false);
    expect(updated.tabs.has("tab-b")).toBe(true);
    expect(updated.activeTabId).toBe("tab-b");
  });
});
