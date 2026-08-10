import { describe, expect, it } from "vitest";

import {
  buildNoteChangedPrompt,
  buildOutboundPrompt,
  createDocumentContext,
  resolveNoteContextInjection,
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

// Pure-function tests for the per-tab note-context dedupe: the fingerprint ->
// resolveNoteContextInjection -> buildOutboundPrompt chain is exactly what
// HermesianView.sendMessage() uses, so these lock the production semantics
// (no document body for changed/none, full document for full) without
// touching the view layer.
describe("resolveNoteContextInjection (fingerprint -> injection kind)", () => {
  it("injects full context when there is no previous fingerprint", () => {
    expect(
      resolveNoteContextInjection({
        previous: undefined,
        currentPath: SENTINEL_PATH,
        currentHash: "abc",
      }),
    ).toBe("full");
  });

  it("injects full context when the path changed", () => {
    expect(
      resolveNoteContextInjection({
        previous: { filePath: "Other/note.md", documentHash: "abc" },
        currentPath: SENTINEL_PATH,
        currentHash: "abc",
      }),
    ).toBe("full");
  });

  it("injects a changed marker when the same path has a different hash", () => {
    expect(
      resolveNoteContextInjection({
        previous: { filePath: SENTINEL_PATH, documentHash: "abc" },
        currentPath: SENTINEL_PATH,
        currentHash: "def",
      }),
    ).toBe("changed");
  });

  it("injects nothing when path and hash are both unchanged", () => {
    expect(
      resolveNoteContextInjection({
        previous: { filePath: SENTINEL_PATH, documentHash: "abc" },
        currentPath: SENTINEL_PATH,
        currentHash: "abc",
      }),
    ).toBe("none");
  });

  it("injects nothing when there is no current path", () => {
    expect(
      resolveNoteContextInjection({
        previous: { filePath: SENTINEL_PATH, documentHash: "abc" },
        currentPath: undefined,
        currentHash: "abc",
      }),
    ).toBe("none");
  });

  it("treats a missing current hash as the empty string (active-note-only fingerprint)", () => {
    // A previous turn with only an active note recorded hash ""; meeting the
    // same path again without a captured body must stay "none", never re-send.
    expect(
      resolveNoteContextInjection({
        previous: { filePath: SENTINEL_PATH, documentHash: "" },
        currentPath: SENTINEL_PATH,
        currentHash: undefined,
      }),
    ).toBe("none");
  });

  it("upgrades to the changed marker when a body becomes available for a path recorded with empty hash", () => {
    expect(
      resolveNoteContextInjection({
        previous: { filePath: SENTINEL_PATH, documentHash: "" },
        currentPath: SENTINEL_PATH,
        currentHash: "abc",
      }),
    ).toBe("changed");
  });
});

describe("buildNoteChangedPrompt (changed-note marker)", () => {
  it("announces the changed note with the obsidian skill hint and no document body", () => {
    const prompt = buildNoteChangedPrompt(SENTINEL_PATH, "继续总结");

    expect(prompt).toContain("<obsidian_context>");
    expect(prompt).toContain(`active_note: ${SENTINEL_PATH}`);
    expect(prompt).toContain("document_included: false");
    expect(prompt).toContain("note_changed: true");
    expect(prompt).toContain("继续总结");
    expect(prompt).toMatch(/obsidian skill/);
    expect(prompt).not.toContain("<document>");
    expect(prompt).not.toContain(SENTINEL_BODY);
  });
});

describe("two-turn dedupe chain through the production builders", () => {
  it("re-sends the full document when there is no previous fingerprint, then stays silent on the identical second turn", () => {
    const doc = sentinelDocumentContext();

    // Turn 1: no previous fingerprint -> full context with the document body.
    const first = buildOutboundPrompt({
      request: "总结",
      isSlashCommand: false,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: doc,
      activeNotePath: SENTINEL_PATH,
      noteContextInjection: resolveNoteContextInjection({
        previous: undefined,
        currentPath: doc.filePath,
        currentHash: doc.documentHash,
      }),
    });
    expect(first).toContain("<document>");
    expect(first).toContain(SENTINEL_BODY);

    // Turn 2: same path + same hash -> none -> request only, no body, no tags.
    const second = buildOutboundPrompt({
      request: "继续",
      isSlashCommand: false,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: doc,
      activeNotePath: SENTINEL_PATH,
      noteContextInjection: resolveNoteContextInjection({
        previous: { filePath: doc.filePath, documentHash: doc.documentHash },
        currentPath: doc.filePath,
        currentHash: doc.documentHash,
      }),
    });
    expect(second).toBe("继续");
    expect(second).not.toContain("<document>");
    expect(second).not.toContain(SENTINEL_BODY);
  });

  it("emits the changed marker without the body when the hash moves between turns", () => {
    const doc = sentinelDocumentContext();
    const prompt = buildOutboundPrompt({
      request: "继续",
      isSlashCommand: false,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: doc,
      activeNotePath: SENTINEL_PATH,
      noteContextInjection: resolveNoteContextInjection({
        previous: { filePath: doc.filePath, documentHash: "old-hash" },
        currentPath: doc.filePath,
        currentHash: doc.documentHash,
      }),
    });

    expect(prompt).toContain("note_changed: true");
    expect(prompt).toContain(`active_note: ${SENTINEL_PATH}`);
    expect(prompt).not.toContain("<document>");
    expect(prompt).not.toContain(SENTINEL_BODY);
  });

  it("re-sends the full document when the path moves between turns", () => {
    const doc = sentinelDocumentContext();
    const prompt = buildOutboundPrompt({
      request: "总结",
      isSlashCommand: false,
      includeCurrentDocumentContext: true,
      selection: undefined,
      documentContext: doc,
      activeNotePath: SENTINEL_PATH,
      noteContextInjection: resolveNoteContextInjection({
        previous: { filePath: "Other/note.md", documentHash: doc.documentHash },
        currentPath: doc.filePath,
        currentHash: doc.documentHash,
      }),
    });

    expect(prompt).toContain("<document>");
    expect(prompt).toContain(SENTINEL_BODY);
  });
});
