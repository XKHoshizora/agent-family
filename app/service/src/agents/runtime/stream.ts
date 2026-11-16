import { stripUnsafeText } from "../../schemas.ts";
import type { Delta } from "./port.ts";

/** At most one delta push per this many milliseconds. */
export const DELTA_INTERVAL_MS = 50;

/** Code points of `s`: what an estimate counts as tokens (metering/prices.ts `estimateTokens`). */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * One reply as it streams: the whole text and reasoning so far, and the pieces not yet pushed. Pieces are coalesced
 * so the owner's sockets get at most one delta every `intervalMs`: the first piece goes out at once, later ones wait
 * for the interval to pass. Characters a message may not hold (`stripUnsafeText`) are left out of the pushes; the
 * stored message is cleaned the same way.
 */
export class ReplyStream {
  text = "";
  reasoning = "";
  private pending: Required<Delta> = { text: "", reasoning: "" };
  private timer: NodeJS.Timeout | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly send: (delta: Delta) => void,
    private readonly intervalMs: number = DELTA_INTERVAL_MS,
  ) {}

  add(kind: "text" | "reasoning", piece: string): void {
    this[kind] += piece;
    this.pending[kind] += piece;
    if (this.timer) return;
    const wait = this.lastSent + this.intervalMs - performance.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Pushes what is pending now (before the reply is posted). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = stripUnsafeText(this.pending.text);
    const reasoning = stripUnsafeText(this.pending.reasoning);
    this.pending = { text: "", reasoning: "" };
    if (text === "" && reasoning === "") return;
    this.lastSent = performance.now();
    this.send({ ...(reasoning === "" ? {} : { reasoning }), ...(text === "" ? {} : { text }) });
  }

  /** Drops what is pending (nothing more will be pushed). */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = { text: "", reasoning: "" };
  }

  /** Characters produced so far, reasoning included: what settlement counts as output when the upstream reports no usage. */
  outputChars(): number {
    return codePoints(this.text) + codePoints(this.reasoning);
  }
}
