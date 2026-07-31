import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real-execution persistence tests for hidden model switch ids.
 *
 * These instantiate the actual production plugin class and drive its real
 * save/load entry points against a controllable saveData/loadData stand-in:
 * a save writes through `savePluginSettings` -> `saveData`, and a simulated
 * restart loads that same payload through the production `loadSettings` path.
 */

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  saveImpl: undefined as ((data: unknown) => Promise<void>) | undefined,
  notices: [] as string[],
}));

vi.mock("obsidian", () => ({
  addIcon: () => {},
  App: class {},
  FileSystemAdapter: class {},
  MarkdownFileInfo: class {},
  MarkdownView: class {},
  Notice: class {
    constructor(message: string) {
      state.notices.push(message);
    }
  },
  Plugin: class {
    app: unknown;
    manifest: unknown;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
    async loadData(): Promise<unknown> {
      return state.data;
    }
    async saveData(data: unknown): Promise<void> {
      if (state.saveImpl) {
        await state.saveImpl(data);
        return;
      }
      state.data = data;
    }
  },
  PluginSettingTab: class {},
  Setting: class {},
  SuggestModal: class {},
  WorkspaceLeaf: class {},
  ItemView: class {},
  MarkdownRenderer: class {},
  setIcon: () => {},
}));

import HermesianPlugin from "../src/main";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createPlugin(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new HermesianPlugin({} as any, { id: "hermesian" } as any) as any;
}

async function loadPlugin(plugin: unknown): Promise<void> {
  await (plugin as { loadSettings(): Promise<void> }).loadSettings();
}

beforeEach(() => {
  state.data = undefined;
  state.saveImpl = undefined;
  state.notices = [];
});

afterEach(() => {
  state.saveImpl = undefined;
});

describe("hidden model persistence (real execution)", () => {
  it("single save writes normalized data through the production saveData path", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds([" a ", "b", "a", "", "  "]);
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "a",
      "b",
    ]);
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
  });

  it("a fresh instance restores the persisted list through the production load path", async () => {
    const first = createPlugin();
    await loadPlugin(first);
    await first.saveHiddenModelSwitchIds(["openai:gpt-4o", "deepseek:r1"]);
    // simulated restart: brand-new plugin instance loads the same payload
    const second = createPlugin();
    await loadPlugin(second);
    expect(second.settings.hiddenModelSwitchIds).toEqual(["openai:gpt-4o", "deepseek:r1"]);
  });

  it("failed save rolls memory back, propagates the error and shows a Notice", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    state.saveImpl = async () => {
      throw new Error("disk full");
    };
    await expect(plugin.saveHiddenModelSwitchIds(["x"])).rejects.toThrow("disk full");
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["base"]);
    expect(
      state.notices.some((notice) => notice.includes("could not save hidden models")),
    ).toBe(true);
    // disk untouched
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "base",
    ]);
  });

  it("a stale failure never overwrites a newer success at the plugin entry point", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const writes: string[][] = [];
    state.saveImpl = async (data) => {
      writes.push((data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds);
      if (writes.length === 1) {
        await firstGate; // hold the first write in flight
        throw new Error("late failure"); // ...then it fails late
      }
      state.data = data; // second (newer) write succeeds
    };
    const first = plugin.saveHiddenModelSwitchIds(["a"]);
    await tick(); // first write is now in flight
    const second = plugin.saveHiddenModelSwitchIds(["a", "b"]);
    releaseFirst();
    await first; // stale failure resolves silently (newer request exists)
    await second;
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
    expect(writes[writes.length - 1]).toEqual(["a", "b"]);
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "a",
      "b",
    ]);
    expect(state.notices).toHaveLength(0); // stale failure is not reported
  });

  it("a stale success is followed by a re-persist of the newest candidate", async () => {
    const plugin = createPlugin();
    await loadPlugin(plugin);
    await plugin.saveHiddenModelSwitchIds(["base"]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const writes: string[][] = [];
    state.saveImpl = async (data) => {
      writes.push((data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds);
      if (writes.length === 1) {
        await firstGate; // first write completes late, after B was queued
      }
      state.data = data;
    };
    const first = plugin.saveHiddenModelSwitchIds(["a"]);
    await tick();
    const second = plugin.saveHiddenModelSwitchIds(["a", "b"]);
    releaseFirst();
    await first;
    await second;
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(["a", "b"]);
    expect(plugin.settings.hiddenModelSwitchIds).toEqual(["a", "b"]);
    expect((state.data as { hiddenModelSwitchIds: string[] }).hiddenModelSwitchIds).toEqual([
      "a",
      "b",
    ]);
  });
});
