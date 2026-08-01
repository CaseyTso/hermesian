import { describe, expect, it } from "vitest";

import {
  buildOutboundPrompt,
  createDocumentContext,
  createSelectionContext,
} from "../src/selection-context";

const vaultPath = "/vault";
const SENTINEL_PATH = "Private/DO_NOT_SEND_7f3a.md";
const SENTINEL_BODY = "SENTINEL_BODY_7f3a 隐私哨兵内容";

function sentinelDocumentContext() {
  return createDocumentContext({
    content: SENTINEL_BODY,
    filePath: SENTINEL_PATH,
    vaultPath,
  });
}

function sentinelSelectionContext() {
  return createSelectionContext({
    content: SENTINEL_BODY,
    filePath: SENTINEL_PATH,
    vaultPath,
    from: { line: 0, ch: 0 },
    to: { line: 0, ch: 15 },
  });
}

// These tests exercise buildOutboundPrompt, the single routing function that
// HermesianView.sendMessage() calls to build the outbound prompt, so they
// cover the real production send path rather than an unwired copy.
describe("buildOutboundPrompt (production send-path routing)", () => {
  it("omits the active note path, title, body, and active_note marker when the context capsule is off", () => {
    const prompt = buildOutboundPrompt({
      request: "你好",
      isSlashCommand: false,
      includeCurrentDocumentContext: false,
      selection: undefined,
      documentContext: undefined,
      // Production never fetches the path in the off state; passing it here
      // proves the router itself cannot leak it even when one is available.
      activeNotePath: SENTINEL_PATH,
    });

    expect(prompt).toBe("你好");
    expect(prompt).toContain("你好");
    expect(prompt).not.toContain(SENTINEL_PATH);
    expect(prompt).not.toContain("DO_NOT_SEND_7f3a");
    expect(prompt).not.toContain(SENTINEL_BODY);
    expect(prompt).not.toContain("active_note");
    expect(prompt).not.toContain("<obsidian_context>");
  });

  it("treats the off switch as authoritative over stale implicit document context", () => {
    const prompt = buildOutboundPrompt({
      request: "你好",
      isSlashCommand: false,
      includeCurrentDocumentContext: false,
      selection: undefined,
      documentContext: sentinelDocumentContext(),
      activeNotePath: SENTINEL_PATH,
    });

    expect(prompt).toBe("你好");
    expect(prompt).not.toContain(SENTINEL_PATH);
    expect(prompt).not.toContain(SENTINEL_BODY);
    expect(prompt).not.toContain("<document>");
  });

  it("includes the full document when the context capsule is on", () => {
    const prompt = buildOutboundPrompt({
      request: "总结这篇笔记",
      isSlashCommand: false,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: sentinelDocumentContext(),
      activeNotePath: SENTINEL_PATH,
    });

    expect(prompt).toContain("<document>");
    expect(prompt).toContain(SENTINEL_BODY);
    expect(prompt).toContain(`文件：${SENTINEL_PATH}`);
    expect(prompt).toContain("总结这篇笔记");
  });

  it("keeps an explicitly added selection (with its document) even when the capsule is off", () => {
    const prompt = buildOutboundPrompt({
      request: "改写选区",
      isSlashCommand: false,
      includeCurrentDocumentContext: false,
      selection: sentinelSelectionContext(),
      documentContext: undefined,
      activeNotePath: SENTINEL_PATH,
    });

    expect(prompt).toContain("<selection>");
    expect(prompt).toContain("<document>");
    expect(prompt).toContain(SENTINEL_PATH);
    expect(prompt).toContain(SENTINEL_BODY);
    expect(prompt).toContain("改写选区");
  });

  it("passes slash commands through unchanged, never wrapped in Obsidian note context", () => {
    const prompt = buildOutboundPrompt({
      request: "/new",
      isSlashCommand: true,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: sentinelDocumentContext(),
      activeNotePath: SENTINEL_PATH,
    });

    expect(prompt).toBe("/new");
    expect(prompt).not.toContain("<obsidian_context>");
    expect(prompt).not.toContain("<document>");
    expect(prompt).not.toContain(SENTINEL_PATH);
  });

  it("falls back to the active-note marker only when the capsule is on but no document context was captured", () => {
    const prompt = buildOutboundPrompt({
      request: "当前笔记是什么",
      isSlashCommand: false,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: undefined,
      activeNotePath: SENTINEL_PATH,
    });

    expect(prompt).toContain(`active_note: ${SENTINEL_PATH}`);
    expect(prompt).toContain("document_included: false");
    expect(prompt).toContain("当前笔记是什么");
    expect(prompt).not.toContain("<document>");
  });

  it("emits exactly the user's request when off and no explicit selection is attached", () => {
    const prompt = buildOutboundPrompt({
      request: "  你好  ",
      isSlashCommand: false,
      includeCurrentDocumentContext: false,
      selection: undefined,
      documentContext: undefined,
      activeNotePath: undefined,
    });

    expect(prompt).toBe("  你好  ");
    expect(prompt).not.toMatch(/obsidian_context|document_included|active_note/);
  });
});
