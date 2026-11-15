import { fileTypeFromBuffer } from "file-type";

const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface Sniffed {
  mime: string;
  /** True only for formats that are safe to render inline in a browser. */
  inline: boolean;
}

/**
 * Decides what a blob is from its leading bytes alone. The client's Content-Type and file name are
 * never consulted. Anything not recognised (HTML, SVG, scripts, ...) is an opaque download.
 * Async because the `file-type` package has no synchronous API.
 */
export async function sniff(head: Buffer): Promise<Sniffed> {
  const found = await fileTypeFromBuffer(head);
  if (!found) return { mime: "application/octet-stream", inline: false };
  return { mime: found.mime, inline: INLINE_MIMES.has(found.mime) };
}
