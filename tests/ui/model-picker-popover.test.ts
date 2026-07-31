// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HermesModelPickerPopover,
  type HermesModelPickerOptions,
  filterVisibleModels,
  groupModelsByProvider,
  normalizeHiddenSwitchIds,
  searchModels,
} from "../../src/ui/model-picker-popover";
import type { HermesModelOption } from "../../src/types";

function makeModel(overrides: Partial<HermesModelOption> = {}): HermesModelOption {
  const providerId = overrides.providerId ?? "openai";
  const modelId = overrides.modelId ?? "gpt-4o";
  return {
    description: "",
    modelId,
    name: "GPT-4o",
    providerId,
    providerName: "OpenAI",
    switchId: `${providerId}:${modelId}`,
    ...overrides,
  };
}

describe("normalizeHiddenSwitchIds", () => {
  it("returns an empty array for missing or non-array values", () => {
    expect(normalizeHiddenSwitchIds(undefined)).toEqual([]);
    expect(normalizeHiddenSwitchIds(null)).toEqual([]);
    expect(normalizeHiddenSwitchIds("openai:gpt-4o")).toEqual([]);
    expect(normalizeHiddenSwitchIds({ 0: "x" })).toEqual([]);
    expect(normalizeHiddenSwitchIds(42)).toEqual([]);
  });

  it("keeps only strings, trims them, drops empty entries and dedupes", () => {
    expect(
      normalizeHiddenSwitchIds([" openai:gpt-4o ", "", "  ", 7, null, "openai:gpt-4o", "deepseek:r1"]),
    ).toEqual(["openai:gpt-4o", "deepseek:r1"]);
  });

  it("preserves first-occurrence order", () => {
    expect(normalizeHiddenSwitchIds(["b", "a", "b", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("filterVisibleModels", () => {
  const models = [
    makeModel({ modelId: "gpt-4o", switchId: "openai:gpt-4o" }),
    makeModel({ modelId: "gpt-4o-mini", switchId: "openai:gpt-4o-mini" }),
    makeModel({ modelId: "claude-3-5-sonnet", providerId: "anthropic", providerName: "Anthropic", switchId: "anthropic:claude-3-5-sonnet" }),
  ];

  it("excludes hidden models", () => {
    const visible = filterVisibleModels(models, ["openai:gpt-4o-mini"], undefined);
    expect(visible.map((m) => m.switchId)).toEqual(["openai:gpt-4o", "anthropic:claude-3-5-sonnet"]);
  });

  it("keeps the current model visible even when hidden", () => {
    const visible = filterVisibleModels(models, ["openai:gpt-4o-mini"], "openai:gpt-4o-mini");
    expect(visible.map((m) => m.switchId)).toEqual([
      "openai:gpt-4o",
      "openai:gpt-4o-mini",
      "anthropic:claude-3-5-sonnet",
    ]);
  });

  it("keeps catalog order and never duplicates", () => {
    const visible = filterVisibleModels(models, [], "openai:gpt-4o");
    expect(visible.map((m) => m.switchId)).toEqual(models.map((m) => m.switchId));
  });

  it("ignores malformed hidden ids safely", () => {
    const visible = filterVisibleModels(models, ["", "   ", 42 as unknown as string], undefined);
    expect(visible).toHaveLength(models.length);
  });
});

describe("groupModelsByProvider", () => {
  it("groups by provider preserving first-occurrence order", () => {
    const models = [
      makeModel({ modelId: "gpt-4o", switchId: "openai:gpt-4o" }),
      makeModel({ modelId: "claude-3-5-sonnet", providerId: "anthropic", providerName: "Anthropic", switchId: "anthropic:claude-3-5-sonnet" }),
      makeModel({ modelId: "gpt-4o-mini", switchId: "openai:gpt-4o-mini" }),
      makeModel({ modelId: "r1", providerId: "deepseek", providerName: "DeepSeek", switchId: "deepseek:r1" }),
    ];
    const groups = groupModelsByProvider(models);
    expect(groups.map((g) => g.id)).toEqual(["openai", "anthropic", "deepseek"]);
    expect(groups[0].models.map((m) => m.switchId)).toEqual(["openai:gpt-4o", "openai:gpt-4o-mini"]);
    expect(groups[1].models.map((m) => m.switchId)).toEqual(["anthropic:claude-3-5-sonnet"]);
  });

  it("returns an empty array for no models", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});

describe("searchModels", () => {
  const models = [
    makeModel({ modelId: "gpt-4o", name: "GPT-4o", description: "Flagship", switchId: "openai:gpt-4o" }),
    makeModel({ modelId: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", providerId: "anthropic", providerName: "Anthropic", switchId: "anthropic:claude-3-5-sonnet" }),
    makeModel({ modelId: "r1", name: "DeepSeek R1", providerId: "deepseek", providerName: "DeepSeek", switchId: "deepseek:r1", description: "reasoning model" }),
  ];

  it("returns all models for an empty or whitespace query", () => {
    expect(searchModels(models, "")).toEqual(models);
    expect(searchModels(models, "   ")).toEqual(models);
  });

  it("matches provider name, provider id, model name, model id and description case-insensitively", () => {
    expect(searchModels(models, "openai").map((m) => m.switchId)).toEqual(["openai:gpt-4o"]);
    expect(searchModels(models, "claude").map((m) => m.switchId)).toEqual(["anthropic:claude-3-5-sonnet"]);
    expect(searchModels(models, "R1").map((m) => m.switchId)).toEqual(["deepseek:r1"]);
    expect(searchModels(models, "flagship").map((m) => m.switchId)).toEqual(["openai:gpt-4o"]);
    expect(searchModels(models, "anthropic")).toHaveLength(1);
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchModels(models, "zzz")).toEqual([]);
  });
});


const MODELS: HermesModelOption[] = [
  makeModel({ modelId: "gpt-4o", switchId: "openai:gpt-4o" }),
  makeModel({ modelId: "gpt-4o-mini", switchId: "openai:gpt-4o-mini" }),
  makeModel({
    description: "Long context",
    modelId: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    providerId: "anthropic",
    providerName: "Anthropic",
    switchId: "anthropic:claude-3-5-sonnet",
  }),
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 630,
    height: 30,
    left: 100,
    right: 300,
    top: 600,
    width: 200,
    x: 100,
    y: 600,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("HermesModelPickerPopover", () => {
  let anchor: HTMLButtonElement;

  beforeEach(() => {
    anchor = document.createElement("button");
    document.body.appendChild(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function openPopover(
    overrides: Partial<HermesModelPickerOptions> = {},
    pickerOverrides: Partial<HermesModelPickerOptions> = {},
  ): {
    picker: HermesModelPickerPopover;
    onChoose: ReturnType<typeof vi.fn>;
    onSaveHidden: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
    container: HTMLElement;
  } {
    const onChoose = vi.fn();
    const onSaveHidden = vi.fn();
    const onClose = vi.fn();
    const picker = new HermesModelPickerPopover({
      anchorEl: anchor,
      currentSwitchId: "openai:gpt-4o",
      hiddenSwitchIds: [],
      models: MODELS,
      onChoose,
      onClose,
      onSaveHidden,
      getViewport: () => ({ height: 768, width: 1024 }),
      ...overrides,
    } as HermesModelPickerOptions);
    void pickerOverrides;
    picker.open();
    return {
      container: document.body.querySelector(".hermesian-model-popover") as HTMLElement,
      onChoose,
      onClose,
      onSaveHidden,
      picker,
    };
  }

  describe("open/close lifecycle", () => {
    it("appends to document.body and marks the anchor expanded", async () => {
      const { container, picker } = openPopover();
      await sleep(30);
      expect(container).toBeTruthy();
      expect(container.getAttribute("role")).toBe("dialog");
      expect(anchor.getAttribute("aria-haspopup")).toBe("listbox");
      expect(anchor.getAttribute("aria-expanded")).toBe("true");
      expect(picker.isOpen()).toBe(true);
    });

    it("focuses the search input on open", async () => {
      openPopover();
      await sleep(30);
      const search = document.body.querySelector(
        ".hermesian-model-popover-search",
      ) as HTMLInputElement;
      expect(document.activeElement).toBe(search);
    });

    it("detach removes the DOM, resets aria and notifies onClose", async () => {
      const { picker, onClose } = openPopover();
      await sleep(30);
      picker.detach();
      expect(document.body.querySelector(".hermesian-model-popover")).toBeNull();
      expect(anchor.getAttribute("aria-expanded")).toBe("false");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(picker.isOpen()).toBe(false);
    });

    it("closes on Escape and cleans up document listeners", async () => {
      const { container, onClose } = openPopover();
      await sleep(30);
      container.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      );
      expect(document.body.querySelector(".hermesian-model-popover")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      // listeners removed: a second Escape or outside pointerdown must not throw
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      );
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on outside pointerdown but not on clicks inside the popover", async () => {
      const { container, onClose } = openPopover();
      await sleep(30);
      (container.querySelector(".hermesian-model-option") as HTMLElement).dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      expect(document.body.querySelector(".hermesian-model-popover")).not.toBeNull();
      document.body.appendChild(document.createElement("div")).dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      expect(document.body.querySelector(".hermesian-model-popover")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("adds a reduced-motion body class when the OS prefers it and removes it on detach", async () => {
      vi.spyOn(window, "matchMedia").mockReturnValue({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as MediaQueryList);
      const { picker } = openPopover();
      await sleep(30);
      expect(document.body.classList.contains("hermesian-reduced-motion")).toBe(true);
      picker.detach();
      expect(document.body.classList.contains("hermesian-reduced-motion")).toBe(false);
    });
  });

  describe("positioning", () => {
    it("anchors above the button, aligned left, capped at 480px tall", async () => {
      const { container } = openPopover();
      await sleep(30);
      expect(container.style.width).toBe("240px");
      expect(container.style.left).toBe("100px");
      expect(container.style.bottom).toBe("176px"); // viewport 768 - anchor top 600 + 8
      expect(container.style.maxHeight).toBe("480px");
    });

    it("clamps left edge and width on narrow viewports", async () => {
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect({ left: 490, right: 690 }));
      const { container } = openPopover({
        getViewport: () => ({ height: 768, width: 500 }),
      });
      await sleep(30);
      expect(container.style.width).toBe("240px");
      expect(container.style.left).toBe("252px"); // min(490, 500 - 240 - 8)
    });

    it("caps width at 420px for wide anchors", async () => {
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect({ width: 600, right: 700 }));
      const { container } = openPopover();
      await sleep(30);
      expect(container.style.width).toBe("420px");
    });

    it("shrinks max-height when little space remains above the button", async () => {
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect({ top: 100, bottom: 130 }));
      const { container } = openPopover();
      await sleep(30);
      expect(container.style.maxHeight).toBe("120px");
    });

    it("repositions on window resize", async () => {
      const viewport = { height: 768, width: 1024 };
      const { container } = openPopover({ getViewport: () => viewport });
      await sleep(30);
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect({ left: 500, right: 700 }));
      viewport.width = 600;
      window.dispatchEvent(new Event("resize"));
      expect(container.style.width).toBe("240px");
      expect(container.style.left).toBe("352px"); // min(500, 600 - 240 - 8)
    });
  });

  describe("select mode", () => {
    it("groups options by provider with labels and marks the current model", async () => {
      const { container } = openPopover();
      await sleep(30);
      const labels = [...container.querySelectorAll(".hermesian-model-group-label")].map(
        (el) => el.textContent,
      );
      expect(labels).toEqual(["OpenAI", "Anthropic"]);
      const rows = container.querySelectorAll(".hermesian-model-option");
      expect(rows).toHaveLength(3);
      const currentRow = container.querySelector(".hermesian-model-option-current");
      expect(currentRow?.textContent).toContain("Current");
      expect(container.querySelector(".hermesian-model-option-check")).toBeTruthy();
    });

    it("keeps the current model visible with a Current badge even when hidden", async () => {
      const { container } = openPopover({ hiddenSwitchIds: ["openai:gpt-4o"] });
      await sleep(30);
      const rows = container.querySelectorAll(".hermesian-model-option");
      expect(rows).toHaveLength(3);
      const currentRow = container
        .querySelector(".hermesian-model-option-current")
        ?.parentElement as HTMLElement;
      expect(currentRow.textContent).toContain("GPT-4o");
    });

    it("filters the list by search across provider, model, id and description", async () => {
      const { container } = openPopover();
      await sleep(30);
      const search = container.querySelector(
        ".hermesian-model-popover-search",
      ) as HTMLInputElement;
      search.value = "claude";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      let rows = container.querySelectorAll(".hermesian-model-option");
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain("Claude 3.5 Sonnet");
      search.value = "long context";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      rows = container.querySelectorAll(".hermesian-model-option");
      expect(rows).toHaveLength(1);
      search.value = "zzz";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      expect(container.querySelectorAll(".hermesian-model-option")).toHaveLength(0);
      const empty = container.querySelector(".hermesian-model-popover-empty") as HTMLElement;
      expect(empty.style.display).not.toBe("none");
      expect(empty.textContent).toContain("No models match");
    });

    it("navigates with arrow keys and chooses once on Enter, then detaches", async () => {
      const { container, onChoose, onClose, picker } = openPopover();
      await sleep(30);
      const rows = (): NodeListOf<HTMLElement> =>
        container.querySelectorAll(".hermesian-model-option");
      container.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
      );
      expect(rows()[0].classList.contains("is-active")).toBe(true);
      container.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
      );
      expect(rows()[1].classList.contains("is-active")).toBe(true);
      container.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }),
      );
      expect(rows()[0].classList.contains("is-active")).toBe(true);
      container.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose.mock.calls[0][0].switchId).toBe("openai:gpt-4o");
      expect(document.body.querySelector(".hermesian-model-popover")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(picker.isOpen()).toBe(false);
      // second Enter after detach must not choose again
      container.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      expect(onChoose).toHaveBeenCalledTimes(1);
    });

    it("chooses a model when clicking a row", async () => {
      const { container, onChoose } = openPopover();
      await sleep(30);
      const rows = container.querySelectorAll(".hermesian-model-option");
      (rows[2] as HTMLElement).click();
      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose.mock.calls[0][0].switchId).toBe("anthropic:claude-3-5-sonnet");
    });

    it("shows an empty state with a Manage models action when everything is hidden", async () => {
      const { container } = openPopover({
        currentSwitchId: undefined,
        hiddenSwitchIds: ["openai:gpt-4o", "openai:gpt-4o-mini", "anthropic:claude-3-5-sonnet"],
      });
      await sleep(30);
      const empty = container.querySelector(".hermesian-model-popover-empty") as HTMLElement;
      expect(empty.style.display).not.toBe("none");
      expect(empty.textContent).toContain("All models are hidden");
      (empty.querySelector(".hermesian-model-popover-empty-action") as HTMLElement).click();
      expect(container.classList.contains("is-manage")).toBe(true);
      expect(container.querySelectorAll(".hermesian-model-manage-row")).toHaveLength(3);
    });
  });

  describe("manage mode", () => {
    it("lists every model including hidden ones and persists visibility changes", async () => {
      const { container, onSaveHidden } = openPopover({
        hiddenSwitchIds: ["openai:gpt-4o-mini"],
      });
      await sleep(30);
      const manageButton = container.querySelector(
        ".hermesian-model-popover-manage-button",
      ) as HTMLElement;
      manageButton.click();
      expect(container.classList.contains("is-manage")).toBe(true);
      const rows = container.querySelectorAll(".hermesian-model-manage-row");
      expect(rows).toHaveLength(3);
      const checkboxes = [...container.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
      const miniBox = checkboxes.find((box) => box.value === "openai:gpt-4o-mini");
      const gpt4oBox = checkboxes.find((box) => box.value === "openai:gpt-4o");
      expect(miniBox?.checked).toBe(false);
      expect(gpt4oBox?.checked).toBe(true);
      // hide gpt-4o as well
      gpt4oBox!.checked = false;
      gpt4oBox!.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onSaveHidden).toHaveBeenCalledTimes(1);
      expect(onSaveHidden.mock.calls[0][0]).toEqual(
        expect.arrayContaining(["openai:gpt-4o-mini", "openai:gpt-4o"]),
      );
      // manage mode still shows every model, so hidden models can always be restored
      expect(container.querySelectorAll(".hermesian-model-manage-row")).toHaveLength(3);
      // back to select: gpt-4o is hidden but is the current model so it stays
      // visible with a Current badge; gpt-4o-mini stays hidden
      (container.querySelector(".hermesian-model-popover-back-button") as HTMLElement).click();
      expect(container.classList.contains("is-manage")).toBe(false);
      const backRows = container.querySelectorAll(".hermesian-model-option");
      expect(backRows).toHaveLength(2);
      expect(backRows[0].textContent).toContain("GPT-4o");
      expect(backRows[0].querySelector(".hermesian-model-option-current")).toBeTruthy();
    });

    it("restores a hidden model from manage mode immediately", async () => {
      const { container, onSaveHidden } = openPopover({
        hiddenSwitchIds: ["openai:gpt-4o-mini"],
      });
      await sleep(30);
      (container.querySelector(".hermesian-model-popover-manage-button") as HTMLElement).click();
      const checkboxes = [...container.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
      const miniBox = checkboxes.find((box) => box.value === "openai:gpt-4o-mini")!;
      miniBox.checked = true;
      miniBox.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onSaveHidden).toHaveBeenCalledWith([]);
    });
  });
});
