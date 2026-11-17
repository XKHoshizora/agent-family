/**
 * What an upstream said about a failed call, for the owner of that provider only (README "Model providers", the
 * `detail` of `POST /api/providers/:id/test` and `…/models/list`): its HTTP status and its own error text, bounded,
 * cleaned, and never anything of the key. Nothing here is ever logged or kept; site models, runs and pushes never see it.
 */

/** The answer's `detail`. `redacted`: the upstream's answer held a piece of the key, so its text was dropped. */
export type UpstreamDetail = { upstreamStatus?: string } & ({ message?: string } | { message: null; redacted: true });

/** At most this many characters (code points) of the upstream's text are passed on. */
export const DETAIL_CHARS = 300;
/** Any run of the key this long, anywhere in the upstream's answer, drops its text. */
export const KEY_PIECE = 6;
/** How much of an error body is read at most; the rest is not looked at. */
export const DETAIL_BODY_BYTES = 64 * 1024;

/** Whether `hay` holds a `size`-long run of `key` (the whole key when it is shorter), ignoring case when `caseless`. */
function holdsRun(hay: string, key: string, size: number, caseless: boolean): boolean {
  if (key === "") return false;
  const k = caseless ? key.toLowerCase() : key;
  const h = caseless ? hay.toLowerCase() : hay;
  if (k.length < size) return h.includes(k);
  const pieces = new Set<string>();
  for (let i = 0; i + size <= k.length; i++) pieces.add(k.slice(i, i + size));
  for (let i = 0; i + size <= h.length; i++) if (pieces.has(h.slice(i, i + size))) return true;
  return false;
}

/** Whether `text` holds the key or any `KEY_PIECE`-long run of it, ignoring case. */
export function holdsKeyPiece(text: string, apiKey: string): boolean {
  return holdsRun(text, apiKey, KEY_PIECE, true);
}

/** Runs of this many characters of the key's base64 / base64url form count as the key (longer than a piece: fewer coincidences). */
const ENCODED_PIECE = 8;

/** `text` with `\uXXXX` escapes decoded. */
const unescaped = (text: string): string => text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
/** `text` with every white space, control and format character removed (escapes decoded first): the key spelled out in pieces. */
const squashed = (text: string): string => unescaped(text).replace(/[\s\p{Cc}\p{Cf}]/gu, "");

/** Whether `text` holds the key as it is, spelled out in pieces, as `\uXXXX` escapes, percent-encoded, or in base64 or base64url. */
function leaksKey(text: string, apiKey: string): boolean {
  const key = Buffer.from(apiKey, "utf8");
  const b64 = key.toString("base64").replace(/=+$/, "");
  const b64url = key.toString("base64url");
  const percent = encodeURIComponent(apiKey);
  for (const v of new Set([text, unescaped(text), squashed(text)])) {
    if (holdsKeyPiece(v, apiKey)) return true;
    if (holdsRun(v, b64, ENCODED_PIECE, false) || holdsRun(v, b64url, ENCODED_PIECE, false)) return true;
    if (percent !== apiKey && holdsRun(v, percent, KEY_PIECE, true)) return true;
  }
  return false;
}

/** The text without control or format characters (line breaks and tabs become spaces), white space collapsed, trimmed. */
function cleaned(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The first `DETAIL_CHARS` code points. */
const bounded = (text: string): string => [...text].slice(0, DETAIL_CHARS).join("");

/** The upstream's own error text in a JSON answer: `error.message`, `message` or `error` when it is a string (also in a one-item list). */
function jsonMessage(body: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const top = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | null | undefined;
  if (!top || typeof top !== "object") return undefined;
  const error = top.error as Record<string, unknown> | string | null | undefined;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  if (typeof top.message === "string") return top.message;
  if (typeof error === "string") return error;
  return undefined;
}

/**
 * The detail of an upstream answer with HTTP status `status` and body `body` (what was read of it): the status, and
 * the upstream's text — its JSON `error.message` / `message` / `error`, else the body itself — cleaned and bounded to
 * `DETAIL_CHARS`. When the body (anywhere in it, not only in that text) or the text holds the key or any `KEY_PIECE`-long
 * run of it, as an upstream echoing the request's headers does, the text is dropped: `message: null, redacted: true`.
 */
export function upstreamDetail(status: number | undefined, body: string | null, apiKey: string): UpstreamDetail {
  const upstreamStatus = status === undefined ? {} : { upstreamStatus: String(status) };
  if (body === null || body === "") return upstreamStatus;
  const raw = jsonMessage(body) ?? body;
  // The text that would be returned is checked as it is returned (cleaned), not only as it came: cleaning removes
  // separators, and a key split by them would otherwise be put back together.
  const text = cleaned(raw);
  if (leaksKey(body, apiKey) || leaksKey(raw, apiKey) || leaksKey(text, apiKey)) return { ...upstreamStatus, message: null, redacted: true };
  const message = bounded(text);
  return message === "" ? upstreamStatus : { ...upstreamStatus, message };
}

/** Up to `limit` bytes of a response's body as text (the rest cancelled); null when it cannot be read. */
export async function readHead(res: Response, limit = DETAIL_BODY_BYTES): Promise<string | null> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, bytes.length - at);
    bytes.set(take, at);
    at += take.byteLength;
    if (at >= bytes.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
