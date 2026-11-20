import { estimateTokens } from "../../metering/tokens.ts";
import { stripUnsafeText } from "../../schemas.ts";
import type { Delta } from "./port.ts";

/** At most one delta push per this many milliseconds. */
export const DELTA_INTERVAL_MS = 50;

/**
 * Where a persona proposal's block (`<af-persona>` and its kin; agents/persona.ts) starts. From the first one in a
 * reply's text, nothing more of that text is pushed: tags never reach a `delta`, and the rest arrives with the stored
 * message, which has the block taken out.
 */
const BLOCK_START = "<af-";

/** How many characters at the end of `s` could be the start of `BLOCK_START` (`<`, `<a`, `<af`): held until the next piece says. */
function pendingStart(s: string): number {
  for (let n = Math.min(BLOCK_START.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(BLOCK_START.slice(0, n))) return n;
  }
  return 0;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * One reply as it streams: the whole text and reasoning so far, and the pieces not yet pushed. Pieces are coalesced
 * so the owner's sockets get at most one delta every `intervalMs`: the first piece goes out at once, later ones wait
 * for the interval to pass. Characters a message may not hold (`stripUnsafeText`) are left out of the pushes; the
 * stored message is cleaned the same way. The text is pushed only up to the first `BLOCK_START` (looked for in the
 * text as cleaned, as the stored message is read): a `<` that may begin one waits for the next piece, and goes out in
 * order once it turns out not to (or at `end`). The reasoning is pushed as it comes.
 */
export class ReplyStream {
  text = "";
  reasoning = "";
  private pending: Required<Delta> = { text: "", reasoning: "" };
  private timer: NodeJS.Timeout | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;
  /** The text as cleaned, piece by piece (what the pushes are cut from). */
  private shown = "";
  /** How much of `shown` has been handed to `pending`. */
  private released = 0;
  /** A block has begun: no more text is pushed. */
  private held = false;
  /** A high surrogate a piece ended with: kept for the next piece, so a pair split across pieces is not cleaned away. */
  private carry = "";

  constructor(
    private readonly send: (delta: Delta) => void,
    private readonly intervalMs: number = DELTA_INTERVAL_MS,
  ) {}

  add(kind: "text" | "reasoning", piece: string): void {
    this[kind] += piece;
    if (kind === "reasoning") this.pending.reasoning += piece;
    else this.addText(piece);
    if (this.timer) return;
    const wait = this.lastSent + this.intervalMs - performance.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  private addText(piece: string): void {
    if (this.held) return;
    let raw = this.carry + piece;
    this.carry = "";
    if (raw !== "" && isHighSurrogate(raw.charCodeAt(raw.length - 1))) {
      this.carry = raw.slice(-1);
      raw = raw.slice(0, -1);
    }
    // Searched from just before what was released: a start that straddles two pieces is found too.
    const from = Math.max(0, this.shown.length - (BLOCK_START.length - 1));
    this.shown += stripUnsafeText(raw);
    const at = this.shown.indexOf(BLOCK_START, from);
    if (at >= 0) this.held = true;
    this.release(at >= 0 ? at : this.shown.length - pendingStart(this.shown));
  }

  /** Hands `shown` up to `upTo` to the next push. */
  private release(upTo: number): void {
    if (upTo <= this.released) return;
    this.pending.text += this.shown.slice(this.released, upTo);
    this.released = upTo;
  }

  /** Pushes what is pending now. */
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.pending.text;
    const reasoning = stripUnsafeText(this.pending.reasoning);
    this.pending = { text: "", reasoning: "" };
    if (text === "" && reasoning === "") return;
    this.lastSent = performance.now();
    this.send({ ...(reasoning === "" ? {} : { reasoning }), ...(text === "" ? {} : { text }) });
  }

  /** The reply is complete (before it is posted): what was held for a `<` that began no block goes out, then everything pending. */
  end(): void {
    if (!this.held) this.release(this.shown.length);
    this.flush();
  }

  /** Drops what is pending (nothing more will be pushed). */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = { text: "", reasoning: "" };
  }

  /**
   * What was produced so far, reasoning included, in weight (`estimateTokens`, metering/tokens.ts): what settlement counts as
   * output when the upstream reports no usage.
   */
  outputChars(): number {
    return estimateTokens(this.text) + estimateTokens(this.reasoning);
  }
}
