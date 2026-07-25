import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  SuggestModal: class {
    app: any;
    scope: any;
    constructor(app: any) {
      this.app = app;
    }
    setPlaceholder(_text: string) {}
    open() {}
    close() {}
    onClose() {}
  },
  setIcon(_el: any, _icon: string) {},
}));

import {
  HermesHistorySuggestModal,
  HermesModelSuggestModal,
  HermesReasoningSuggestModal,
} from "../../src/ui/conversation-modals";
import type {
  HermesHistoryEntry,
  HermesModelOption,
} from "../../src/types";

function fakeModelOption(overrides: Partial<HermesModelOption> = {}): HermesModelOption {
  return {
    description: "",
    modelId: "model-1",
    name: "GPT-4o",
    providerId: "openai",
    providerName: "OpenAI",
    switchId: "openai:gpt-4o",
    ...overrides,
  };
}

function fakeHistoryEntry(overrides: Partial<HermesHistoryEntry> = {}): HermesHistoryEntry {
  return {
    cwd: "/vault",
    sessionId: "session-1",
    title: "Research chat",
    updatedAt: "2026-07-25",
    ...overrides,
  };
}

describe("HermesModelSuggestModal", () => {
  it("calls the choose callback with the selected model", () => {
    const choose = vi.fn();
    const modal = new HermesModelSuggestModal(
      { vault: { getName: () => "test" } } as any,
      [fakeModelOption({ name: "GPT-4o" }), fakeModelOption({ name: "Claude" })],
      undefined,
      choose,
    );

    const model = fakeModelOption({ name: "GPT-4o" });
    modal.onChooseSuggestion(model);
    expect(choose).toHaveBeenCalledWith(model);
  });

  it("filters models by query", () => {
    const models = [
      fakeModelOption({ name: "GPT-4o", providerName: "OpenAI", providerId: "openai" }),
      fakeModelOption({ name: "Claude", providerName: "Anthropic", providerId: "anthropic" }),
    ];
    const modal = new HermesModelSuggestModal(
      { vault: { getName: () => "test" } } as any,
      models,
      undefined,
      vi.fn(),
    );

    expect(modal.getSuggestions("openai")).toHaveLength(1);
    expect(modal.getSuggestions("openai")[0].name).toBe("GPT-4o");
    expect(modal.getSuggestions("nonexistent")).toHaveLength(0);
  });
});

describe("HermesHistorySuggestModal", () => {
  it("calls the choose callback with the selected session", () => {
    const choose = vi.fn();
    const modal = new HermesHistorySuggestModal(
      { vault: { getName: () => "test" } } as any,
      [fakeHistoryEntry({ title: "Research" })],
      choose,
    );

    const session = fakeHistoryEntry({ title: "Research" });
    modal.onChooseSuggestion(session);
    expect(choose).toHaveBeenCalledWith(session);
  });

  it("filters sessions by title and sessionId", () => {
    const sessions = [
      fakeHistoryEntry({ title: "Research chat", sessionId: "abc" }),
      fakeHistoryEntry({ title: "Debug session", sessionId: "def" }),
    ];
    const modal = new HermesHistorySuggestModal(
      { vault: { getName: () => "test" } } as any,
      sessions,
      vi.fn(),
    );

    expect(modal.getSuggestions("research")).toHaveLength(1);
    expect(modal.getSuggestions("def")).toHaveLength(1);
    expect(modal.getSuggestions("missing")).toHaveLength(0);
  });
});

describe("HermesReasoningSuggestModal", () => {
  it("calls the choose callback with the selected effort", () => {
    const choose = vi.fn();
    const modal = new HermesReasoningSuggestModal(
      { vault: { getName: () => "test" } } as any,
      "medium",
      choose,
    );

    modal.onChooseSuggestion("high");
    expect(choose).toHaveBeenCalledWith("high");
  });

  it("filters reasoning efforts by label", () => {
    const modal = new HermesReasoningSuggestModal(
      { vault: { getName: () => "test" } } as any,
      "medium",
      vi.fn(),
    );

    const results = modal.getSuggestions("low");
    expect(results).toContain("low");
  });

  it("returns all reasoning efforts when query is empty", () => {
    const modal = new HermesReasoningSuggestModal(
      { vault: { getName: () => "test" } } as any,
      "medium",
      vi.fn(),
    );

    expect(modal.getSuggestions("").length).toBeGreaterThanOrEqual(3);
  });
});
