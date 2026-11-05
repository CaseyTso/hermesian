import { describe, expect, it, vi } from "vitest";

const registeredCommands: Array<{
  id: string;
  name: string;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
  checkCallback?: (checking: boolean) => boolean | void;
  callback?: () => void;
}> = [];

vi.mock("obsidian", () => ({
  addIcon: () => {},
  App: class {},
  FileSystemAdapter: class {},
  MarkdownFileInfo: class {},
  MarkdownView: class {},
  Notice: class {
    constructor(public message: string) {}
  },
  Plugin: class {
    app: unknown;
    manifest: unknown;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
    addCommand(cmd: any) {
      registeredCommands.push(cmd);
      return cmd;
    }
    registerView() {}
    addRibbonIcon() {}
    addSettingTab() {}
    registerEvent() {}
    async loadData() {
      return {};
    }
    async saveData() {}
  },
  PluginSettingTab: class {},
  Setting: class {},
  Modal: class {},
  SuggestModal: class {},
  WorkspaceLeaf: class {},
  ItemView: class {},
  MarkdownRenderer: class {},
  setIcon: () => {},
}));

import HermesianPlugin from "../src/main";

describe("Conversation tab switching commands", () => {
  it("registers next and previous tab commands with default hotkeys", async () => {
    registeredCommands.length = 0;
    const fakeApp = {
      workspace: {
        getActiveViewOfType: () => undefined,
        on: () => {},
      },
    };
    const plugin = new HermesianPlugin(fakeApp as any, { id: "hermesian" } as any);
    await plugin.onload();

    const nextCmd = registeredCommands.find((c) => c.id === "next-conversation-tab");
    const prevCmd = registeredCommands.find((c) => c.id === "previous-conversation-tab");

    expect(nextCmd).toBeDefined();
    expect(nextCmd?.name).toBe("Switch to next conversation tab");
    expect(nextCmd?.hotkeys).toEqual([{ modifiers: ["Alt"], key: "Tab" }]);

    expect(prevCmd).toBeDefined();
    expect(prevCmd?.name).toBe("Switch to previous conversation tab");
    expect(prevCmd?.hotkeys).toEqual([{ modifiers: ["Alt", "Shift"], key: "Tab" }]);
  });

  it("checkCallback returns false when sidebar is not attached or only one tab exists", async () => {
    registeredCommands.length = 0;
    const fakeApp = {
      workspace: {
        getActiveViewOfType: () => undefined,
        on: () => {},
      },
    };
    const plugin = new HermesianPlugin(fakeApp as any, { id: "hermesian" } as any);
    await plugin.onload();

    const nextCmd = registeredCommands.find((c) => c.id === "next-conversation-tab")!;

    // Case 1: sidebarView not attached
    expect(nextCmd.checkCallback!(true)).toBe(false);

    // Case 2: sidebarView attached, but only 1 tab
    const mockView = {
      cycleConversationTab: vi.fn(),
      setCurrentFile: vi.fn(),
    };
    plugin.attachView(mockView as any);
    (plugin as any).conversationWorkspace = {
      activeTabId: "tab-1",
      nextLabel: 2,
      tabs: [{ id: "tab-1", label: 1, draft: "", sessionId: "s-1", includeCurrentDocumentContext: true }],
      version: 2,
    };
    expect(nextCmd.checkCallback!(true)).toBe(false);

    // Case 3: sidebarView attached and multiple tabs exist
    (plugin as any).conversationWorkspace.tabs.push({
      id: "tab-2",
      label: 2,
      draft: "",
      sessionId: "s-2",
      includeCurrentDocumentContext: true,
    });
    expect(nextCmd.checkCallback!(true)).toBe(true);
  });
});
