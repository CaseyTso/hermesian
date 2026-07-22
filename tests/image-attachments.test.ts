import { describe, expect, it } from "vitest";

import {
  buildImagePrompt,
  imageAttachmentFromDataUrl,
  isImageClipboardItem,
} from "../src/image-attachments";

describe("image attachments", () => {
  it("recognizes image clipboard files without intercepting text paste", () => {
    expect(isImageClipboardItem({ kind: "file", type: "image/png" })).toBe(true);
    expect(isImageClipboardItem({ kind: "string", type: "text/plain" })).toBe(false);
    expect(isImageClipboardItem({ kind: "file", type: "text/plain" })).toBe(false);
  });

  it("parses a clipboard data URL into an ACP-ready attachment", () => {
    expect(
      imageAttachmentFromDataUrl("data:image/jpeg;base64,ZmFrZQ==", "image-1"),
    ).toEqual({
      data: "ZmFrZQ==",
      id: "image-1",
      mimeType: "image/jpeg",
    });
  });

  it("builds a text block followed by image content blocks", () => {
    expect(
      buildImagePrompt("Describe this", [
        { data: "aW1hZ2U=", id: "image-1", mimeType: "image/png" },
      ]),
    ).toEqual([
      { text: "Describe this", type: "text" },
      { data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
    ]);
  });
});
