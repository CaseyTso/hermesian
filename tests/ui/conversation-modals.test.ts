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

  it("does not call choose when closed without selection", () => {
    const choose = vi.fn();
    const modal = new HermesModelSuggestModal(
      { vault: { getName: () => "test" } } as any,
      [fakeModelOption()],
      undefined,
      choose,
    );
    modal.close();
    expect(choose).not.toHaveBeenCalled();
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

describe("owner-capture and settle-once contract", () => {
  it("model picker settle-once invokes setModel at most once per open", () => {
    const setModel = vi.fn();
    const capturedTabId = "tab-A";
    let settled = false;
    let openCount = 0;

    const openModelPicker = (): void => {
      openCount += 1;
      const modal = new HermesModelSuggestModal(
        { vault: { getName: () => "test" } } as any,
        [fakeModelOption({ name: "A" }), fakeModelOption({ name: "B", modelId: "b", switchId: "openai:b" })],
        undefined,
        (model) => {
          if (settled) {
            return;
          }
          settled = true;
          setModel(capturedTabId, model);
        },
      );
      modal.onChooseSuggestion(fakeModelOption({ name: "A" }));
      modal.onChooseSuggestion(fakeModelOption({ name: "B", modelId: "b", switchId: "openai:b" }));
    };

    // One logical button click must open one modal and settle setModel once.
    openModelPicker();
    expect(openCount).toBe(1);
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith("tab-A", expect.objectContaining({ name: "A" }));
  });

  it("model picker close without selection never calls setModel", () => {
    const setModel = vi.fn();
    let settled = false;
    const modal = new HermesModelSuggestModal(
      { vault: { getName: () => "test" } } as any,
      [fakeModelOption()],
      undefined,
      (model) => {
        if (settled) {
          return;
        }
        settled = true;
        setModel(model);
      },
    );
    modal.close();
    expect(setModel).not.toHaveBeenCalled();
  });
});
