import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock obsidian
vi.mock("obsidian", () => ({
  Modal: class {
    app: any;
    modalEl: HTMLElement;
    titleEl: HTMLElement;
    contentEl: HTMLElement;
    constructor(app: any) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.modalEl.className = "modal";
      this.titleEl = document.createElement("div");
      this.titleEl.className = "modal-title";
      this.contentEl = document.createElement("div");
      this.contentEl.className = "modal-content";
      this.modalEl.appendChild(this.titleEl);
      this.modalEl.appendChild(this.contentEl);
    }
    setTitle(title: string) {
      this.titleEl.textContent = title;
      return this;
    }
    open() {
      this.onOpen();
    }
    close() {
      this.onClose();
      this.modalEl.remove();
    }
    onOpen() {}
    onClose() {}
  },
  Notice: vi.fn(),
  setIcon: vi.fn((el: HTMLElement, iconId: string) => {
    el.setAttribute("data-icon", iconId);
    el.innerHTML = `<svg data-icon="${iconId}"></svg>`;
  }),
}));

import { Notice } from "obsidian";
import {
  DiagramModal,
  copyPngToClipboard,
  copyTextToClipboard,
  getDiagramFilename,
  getLastSavedDirectory,
  parseSvgDimensions,
  prepareSvgForExport,
  resolvePeleStyles,
  savePngToFile,
  setLastSavedDirectory,
  svgToPngBlob,
} from "../../src/ui/diagram-modal";

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart" viewBox="0 0 200 100" width="200" height="100"><text>Hello</text></svg>';

describe("diagram-modal", () => {
  let window: Window;

  beforeEach(() => {
    window = new Window();
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("HTMLButtonElement", window.HTMLButtonElement);
    setLastSavedDirectory(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("parseSvgDimensions", () => {
    it("parses width and height attributes", () => {
      const svg = '<svg width="350" height="175"></svg>';
      expect(parseSvgDimensions(svg)).toEqual({ width: 350, height: 175 });
    });

    it("parses width and height with px units", () => {
      const svg = '<svg width="240px" height="120px"></svg>';
      expect(parseSvgDimensions(svg)).toEqual({ width: 240, height: 120 });
    });

    it("falls back to viewBox when width/height are absent", () => {
      const svg = '<svg viewBox="0 0 500 250"></svg>';
      expect(parseSvgDimensions(svg)).toEqual({ width: 500, height: 250 });
    });

    it("falls back to default dimensions when neither width nor viewBox are available", () => {
      const svg = "<svg></svg>";
      expect(parseSvgDimensions(svg)).toEqual({ width: 800, height: 600 });
    });
  });

  describe("getDiagramFilename", () => {
    it("generates timestamp-based filename matching diagram-YYYYMMDD-HHmmss.png", () => {
      const filename = getDiagramFilename();
      expect(filename).toMatch(/^diagram-\d{8}-\d{6}\.png$/);
    });

    it("correctly formats a specific date", () => {
      const testDate = new Date(2026, 3, 8, 14, 30, 22); // Month is 0-indexed: 3 = April
      expect(getDiagramFilename(testDate)).toBe("diagram-20260408-143022.png");
    });
  });

  describe("resolvePeleStyles & prepareSvgForExport", () => {
    it("extracts CSS variables when available", () => {
      const container = window.document.createElement("div") as any;
      container.style.setProperty("--pele-bg", "#ffffff");
      container.style.setProperty("--pele-fg", "#111111");
      window.document.body.appendChild(container);

      const resolved = resolvePeleStyles(window.document as any, container);
      expect(resolved.backgroundColor).toBeDefined();
    });

    it("adds xmlns and style block to SVG for export", () => {
      const raw = '<svg width="100" height="50"><rect/></svg>';
      const prepared = prepareSvgForExport(raw, {
        cssDeclarations: "--pele-bg: #fff; --pele-fg: #000;",
        backgroundColor: "#fff",
        variables: {},
      });

      expect(prepared).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(prepared).toContain("<style>:root, svg {");
      expect(prepared).toContain("--pele-bg: #fff;");
    });
  });

  describe("svgToPngBlob", () => {
    it("converts SVG to PNG Blob using mock Canvas and mock Image", async () => {
      const fillRectMock = vi.fn();
      const drawImageMock = vi.fn();

      const blobResult = await svgToPngBlob(SAMPLE_SVG, {
        scale: 2,
        doc: window.document as any,
        createImage: () => {
          let src = "";
          return {
            onload: null,
            onerror: null,
            set src(val: string) {
              src = val;
              setTimeout(() => (this as any).onload?.(), 0);
            },
            get src() {
              return src;
            },
          } as any;
        },
        createCanvas: (w, h) => {
          expect(w).toBe(400); // 200 * 2
          expect(h).toBe(200); // 100 * 2
          return {
            getContext: () => ({
              fillRect: fillRectMock,
              drawImage: drawImageMock,
              fillStyle: "",
            }),
            toBlob: (callback: (blob: Blob | null) => void) => {
              callback(new Blob(["mock-png-data"], { type: "image/png" }));
            },
          };
        },
      });

      expect(blobResult).toBeInstanceOf(Blob);
      expect(blobResult.type).toBe("image/png");
      expect(fillRectMock).toHaveBeenCalled();
      expect(drawImageMock).toHaveBeenCalled();
    });

    it("handles toDataURL fallback when toBlob is absent", async () => {
      const blobResult = await svgToPngBlob(SAMPLE_SVG, {
        scale: 1,
        doc: window.document as any,
        createImage: () => {
          let src = "";
          return {
            onload: null,
            onerror: null,
            set src(val: string) {
              src = val;
              setTimeout(() => (this as any).onload?.(), 0);
            },
            get src() {
              return src;
            },
          } as any;
        },
        createCanvas: () => ({
          getContext: () => ({
            fillRect: vi.fn(),
            drawImage: vi.fn(),
            fillStyle: "",
          }),
          toDataURL: () => "data:image/png;base64,aGVsbG8=",
        }),
      });

      expect(blobResult).toBeInstanceOf(Blob);
      expect(blobResult.type).toBe("image/png");
    });
  });

  describe("copyPngToClipboard", () => {
    it("writes image/png ClipboardItem to clipboard", async () => {
      const writeMock = vi.fn(async () => {});
      const mockClipboard = { write: writeMock };

      class MockClipboardItem {
        data: Record<string, Blob>;
        constructor(data: Record<string, Blob>) {
          this.data = data;
        }
      }
      vi.stubGlobal("ClipboardItem", MockClipboardItem);

      const blob = new Blob(["png"], { type: "image/png" });
      const success = await copyPngToClipboard(blob, mockClipboard);

      expect(success).toBe(true);
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    it("returns false if clipboard write fails", async () => {
      const mockClipboard = {
        write: vi.fn(async () => {
          throw new Error("Permission denied");
        }),
      };

      class MockClipboardItem {
        constructor(public data: any) {}
      }
      vi.stubGlobal("ClipboardItem", MockClipboardItem);

      const blob = new Blob(["png"], { type: "image/png" });
      const success = await copyPngToClipboard(blob, mockClipboard);

      expect(success).toBe(false);
    });
  });

  describe("copyTextToClipboard", () => {
    it("copies text using writeText method", async () => {
      const writeTextMock = vi.fn(async () => {});
      const success = await copyTextToClipboard("graph TD; A-->B", {
        writeText: writeTextMock,
      });

      expect(success).toBe(true);
      expect(writeTextMock).toHaveBeenCalledWith("graph TD; A-->B");
    });
  });

  describe("savePngToFile", () => {
    it("uses Electron showSaveDialog and saves file via writeFile", async () => {
      const showSaveDialogMock = vi.fn(async (_options: any) => ({
        canceled: false,
        filePath: "/mock/path/diagram-20260408-143022.png",
      }));
      const writeFileMock = vi.fn(async () => {});
      const showNoticeMock = vi.fn();

      const blob = new Blob(["png-data"], { type: "image/png" });
      const savedPath = await savePngToFile({
        app: {
          fileManager: {
            getAvailablePathForAttachment: vi.fn(async () => "diagram.png"),
          },
          vault: {
            adapter: { getBasePath: () => "/vault" },
            createBinary: vi.fn(),
          },
        } as any,
        blob,
        filename: "diagram-test.png",
        dialog: { showSaveDialog: showSaveDialogMock },
        writeFile: writeFileMock,
        showNotice: showNoticeMock,
      });

      expect(savedPath).toBe("/mock/path/diagram-20260408-143022.png");
      expect(showSaveDialogMock).toHaveBeenCalledTimes(1);
      expect(showSaveDialogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.arrayContaining([
            { name: "PNG Image", extensions: ["png"] },
          ]),
        }),
      );
      expect(writeFileMock).toHaveBeenCalledTimes(1);
      expect(showNoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("/mock/path/diagram-20260408-143022.png"),
      );
      expect(getLastSavedDirectory()).toBe("/mock/path");
    });

    it("uses lastSavedDirectory for subsequent dialog calls", async () => {
      setLastSavedDirectory("/previous/dir");

      const showSaveDialogMock = vi.fn(async () => ({
        canceled: true,
      }));

      await savePngToFile({
        app: {
          fileManager: {
            getAvailablePathForAttachment: vi.fn(async () => "diagram.png"),
          },
          vault: { adapter: {} },
        } as any,
        blob: new Blob(["png"], { type: "image/png" }),
        filename: "test.png",
        dialog: { showSaveDialog: showSaveDialogMock },
      });

      expect(showSaveDialogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: expect.stringContaining("/previous/dir/test.png"),
        }),
      );
    });

    it("returns null when user cancels save dialog", async () => {
      const showSaveDialogMock = vi.fn(async () => ({
        canceled: true,
      }));
      const writeFileMock = vi.fn();

      const saved = await savePngToFile({
        app: {} as any,
        blob: new Blob(["png"], { type: "image/png" }),
        dialog: { showSaveDialog: showSaveDialogMock },
        writeFile: writeFileMock,
      });

      expect(saved).toBeNull();
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it("falls back to vault createBinary when dialog is unavailable", async () => {
      const createBinaryMock = vi.fn(async () => {});
      const showNoticeMock = vi.fn();

      const savedPath = await savePngToFile({
        app: {
          fileManager: {
            getAvailablePathForAttachment: vi.fn(
              async (name: string) => `attachments/${name}`,
            ),
          },
          vault: {
            createBinary: createBinaryMock,
            adapter: {},
          },
        } as any,
        blob: new Blob(["data"], { type: "image/png" }),
        filename: "diagram-fallback.png",
        dialog: undefined,
        showNotice: showNoticeMock,
      });

      expect(savedPath).toBe("attachments/diagram-fallback.png");
      expect(createBinaryMock).toHaveBeenCalledTimes(1);
      expect(showNoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("attachments/diagram-fallback.png"),
      );
    });
  });

  describe("DiagramModal component", () => {
    let mockApp: any;

    beforeEach(() => {
      mockApp = {
        fileManager: {
          getAvailablePathForAttachment: vi.fn(
            async (f: string) => `attachments/${f}`,
          ),
        },
        vault: {
          adapter: { getBasePath: () => "/mock/vault" },
          createBinary: vi.fn(),
        },
      };
    });

    it("initializes modal with title, container class, and layout", () => {
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
      );
      modal.onOpen();

      expect(modal.titleEl.textContent).toBe("图表预览");
      expect(modal.modalEl.classList.contains("hermesian-diagram-modal")).toBe(
        true,
      );

      // Check zoom controls
      expect(modal.zoomTextEl?.textContent).toBe("100%");

      // Check viewport & SVG
      expect(modal.viewportEl).not.toBeNull();
      expect(modal.svgEl).not.toBeNull();
      expect(modal.svgEl?.style.width).toBe("200px");
      expect(modal.svgEl?.style.height).toBe("100px");

      // Check action buttons
      expect(modal.exportBtnEl).not.toBeNull();
      expect(modal.copyPngBtnEl).not.toBeNull();
      expect(modal.copySourceBtnEl).not.toBeNull();
      expect(modal.closeBtnEl).not.toBeNull();
    });

    it("handles zoom in, zoom out, and reset controls", () => {
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
      );
      modal.onOpen();

      expect(modal.zoom).toBe(1.0);

      // Zoom in
      modal.zoomIn();
      expect(modal.zoom).toBeGreaterThan(1.0);
      expect(modal.zoomTextEl?.textContent).toBe(
        `${Math.round(modal.zoom * 100)}%`,
      );
      expect(modal.svgEl?.style.width).toBe(
        `${Math.round(200 * modal.zoom)}px`,
      );

      // Reset
      modal.resetZoom();
      expect(modal.zoom).toBe(1.0);
      expect(modal.zoomTextEl?.textContent).toBe("100%");

      // Zoom out
      modal.zoomOut();
      expect(modal.zoom).toBeLessThan(1.0);
      expect(modal.zoomTextEl?.textContent).toBe(
        `${Math.round(modal.zoom * 100)}%`,
      );
      expect(modal.svgEl?.style.width).toBe(
        `${Math.round(200 * modal.zoom)}px`,
      );
    });

    it("handles wheel zoom with Ctrl/Cmd modifier", () => {
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
      );
      modal.onOpen();

      // Dispatch wheel up with ctrlKey
      const wheelUp = new (window as any).WheelEvent("wheel", {
        deltaY: -100,
      });
      Object.defineProperty(wheelUp, "ctrlKey", { value: true });
      modal.viewportEl?.dispatchEvent(wheelUp);
      expect(modal.zoom).toBeGreaterThan(1.0);

      // Dispatch wheel down with ctrlKey
      const wheelDown = new (window as any).WheelEvent("wheel", {
        deltaY: 100,
      });
      Object.defineProperty(wheelDown, "ctrlKey", { value: true });
      modal.viewportEl?.dispatchEvent(wheelDown);
      expect(modal.zoom).toBe(1.0);
    });

    it("executes exportPng flow when export button is clicked", async () => {
      const fileSaverMock = vi.fn(async () => "/saved/diagram.png");
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
        {
          svgToPng: async () => new Blob(["png"], { type: "image/png" }),
          fileSaver: fileSaverMock,
        },
      );
      modal.onOpen();

      const saved = await modal.exportPng();
      expect(saved).toBe("/saved/diagram.png");
      expect(fileSaverMock).toHaveBeenCalledTimes(1);
    });

    it("copies PNG to clipboard and triggers visual checkmark feedback", async () => {
      const writeMock = vi.fn(async () => {});
      class MockClipboardItem {
        constructor(public data: any) {}
      }
      vi.stubGlobal("ClipboardItem", MockClipboardItem);

      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
        {
          svgToPng: async () => new Blob(["png"], { type: "image/png" }),
          clipboard: { write: writeMock },
        },
      );
      modal.onOpen();

      const success = await modal.copyPng();
      expect(success).toBe(true);
      expect(writeMock).toHaveBeenCalledTimes(1);

      // Feedback state
      expect(modal.copyPngBtnEl?.classList.contains("is-copied")).toBe(true);
      expect(modal.copyPngTextEl?.textContent).toBe("已复制");
      expect(Notice).toHaveBeenCalledWith("图片已复制到剪贴板");
    });

    it("copies Mermaid source to clipboard and triggers checkmark feedback", async () => {
      const writeTextMock = vi.fn(async () => {});
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
        {
          clipboard: { writeText: writeTextMock },
        },
      );
      modal.onOpen();

      const success = await modal.copySource();
      expect(success).toBe(true);
      expect(writeTextMock).toHaveBeenCalledWith("graph TD\n  A --> B");

      expect(modal.copySourceBtnEl?.classList.contains("is-copied")).toBe(true);
      expect(modal.copySourceTextEl?.textContent).toBe("已复制");
      expect(Notice).toHaveBeenCalledWith("源码已复制到剪贴板");
    });

    it("closes modal when close button is clicked", () => {
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
      );
      const closeSpy = vi.spyOn(modal, "close");
      modal.onOpen();

      modal.closeBtnEl?.click();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("cleans up content and timers on onClose", () => {
      const modal = new DiagramModal(
        mockApp,
        SAMPLE_SVG,
        "graph TD\n  A --> B",
      );
      modal.onOpen();
      expect(modal.contentEl.childNodes.length).toBeGreaterThan(0);

      modal.onClose();
      expect(modal.contentEl.innerHTML).toBe("");
    });
  });
});
