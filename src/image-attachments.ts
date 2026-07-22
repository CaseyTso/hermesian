import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface PastedImageAttachment {
  data: string;
  id: string;
  mimeType: string;
}

export const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

export function isImageClipboardItem(item: {
  kind?: string;
  type?: string;
}): boolean {
  return item.kind === "file" && (item.type ?? "").toLowerCase().startsWith("image/");
}

export function imageAttachmentFromDataUrl(
  dataUrl: string,
  id: string,
  fallbackMimeType = "image/png",
): PastedImageAttachment {
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Clipboard image data is not a valid base64 data URL");
  }
  return {
    data: match[2],
    id,
    mimeType: match[1] || fallbackMimeType,
  };
}

export function buildImagePrompt(
  text: string,
  images: readonly PastedImageAttachment[],
): ContentBlock[] {
  return [
    { type: "text", text },
    ...images.map(({ data, mimeType }) => ({
      type: "image" as const,
      data,
      mimeType,
    })),
  ];
}
