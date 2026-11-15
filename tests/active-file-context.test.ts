import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceEvents = new Map<string, (value: any) => void>();

vi.mock("obsidian", () => ({
  addIcon: () => {},
  App: class {},
  FileSystemAdapter: class {},
  FileView: class {
    file: any;
    constructor(file?: any) {
      this.file = file;
    }
  },
  MarkdownFileInfo: class {},
  MarkdownView: class {
    file: any;
    constructor(file?: any) {
      this.file = file;
    }
  },
  Notice: class {},
  Plugin: class {
    app: any;
    manifest: any;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
    addCommand() {}
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

describe("Active file context", () => {
  beforeEach(() => {
    workspaceEvents.clear();
  });

  async function harness() {
    const { FileView, MarkdownView } = await import("obsidian");
    const markdownView = new (MarkdownView as any)({ path: "Research/old note.md" });
    const pdfFile = { path: "05 Literature/研究 报告.pdf", extension: "pdf" };
    const pdfLeaf = { view: new (FileView as any)(pdfFile) };
    let activeFile: any = markdownView.file;
    let activeLeaf: any = { view: markdownView };
    const sidebarView = { setCurrentFile: vi.fn() };
    const app = {
      workspace: {
        get activeLeaf() {
          return activeLeaf;
        },
        getActiveViewOfType: (type: unknown) =>
          type === MarkdownView && activeLeaf?.view instanceof MarkdownView
            ? activeLeaf.view
            : undefined,
        getActiveFile: () => activeFile,
        on: (name: string, callback: (value: any) => void) => {
          workspaceEvents.set(name, callback);
          return {};
        },
      },
    };
    const plugin = new HermesianPlugin(app as any, { id: "hermesian" } as any);
    await plugin.onload();
    (plugin as any).sidebarView = sidebarView;
    return {
      plugin,
      sidebarView,
      pdfFile,
      pdfLeaf,
      activate: (leaf: any, file?: any) => {
        activeLeaf = leaf;
        activeFile = file;
        workspaceEvents.get("active-leaf-change")?.(leaf);
      },
      open: (file: any) => workspaceEvents.get("file-open")?.(file),
    };
  }

  it("tracks the active PDF through sidebar focus and back to Markdown", async () => {
    const h = await harness();
    h.activate(h.pdfLeaf, h.pdfFile);
    expect(h.plugin.getCurrentFilePath()).toBe(h.pdfFile.path);
    expect(h.sidebarView.setCurrentFile).toHaveBeenLastCalledWith(h.pdfFile.path);

    const { HermesianSidebarView } = await import("../src/view");
    const sidebar = new HermesianSidebarView({} as any, h.plugin);
    h.activate({ view: sidebar });
    expect(h.plugin.getCurrentFilePath()).toBe(h.pdfFile.path);

    h.open(h.pdfFile);
    expect(h.plugin.getCurrentFilePath()).toBe(h.pdfFile.path);

    h.open(null);
    expect(h.plugin.getCurrentFilePath()).toBeUndefined();
    expect(h.sidebarView.setCurrentFile).toHaveBeenLastCalledWith(undefined);
  });

  it("does not adopt a background file opened while another page remains active", async () => {
    const h = await harness();
    h.open({ path: "Research/background.pdf" });
    expect(h.plugin.getCurrentFilePath()).toBe("Research/old note.md");
  });

  it("keeps the existing Markdown-only source for document content and selection", async () => {
    const app = {
      workspace: {
        getActiveViewOfType: () => undefined,
        getActiveFile: () => ({ path: "Research/paper.pdf", extension: "pdf" }),
        on: () => ({}),
      },
    };
    const plugin = new HermesianPlugin(app as any, { id: "hermesian" } as any);
    await plugin.onload();
    expect(plugin.getCurrentFilePath()).toBe("Research/paper.pdf");
    expect(plugin.getCurrentDocumentContext()).toBeUndefined();
    expect(plugin.getCurrentMarkdownFilePath()).toBeUndefined();
  });
});
