import type { StoredOp } from "./apply.ts";

/**
 * What a change tells the owner, line by line (a notice carries these, never the change's own record). Two tenses, because a card
 * that asks first must not read like something already done (`记住` on a line that says `忘掉了` is a trap): a change waiting for the
 * owner's yes is in the future (`要记住：…` / `要改成：…` / `要忘掉：…` / `要锁进保险箱：…`; a dream's `要合并成：…` / `要拆成：…`); one
 * that is done is in the past (`记住了：…` / `改成了：…` / `忘掉了：…` / `锁进了保险箱：…`; `合并了 k 条：…` followed by `原来：…` for each note
 * it joined / `拆成了：…`). A request to
 * take a note out of the vault is the note's text in either. `vaultLines` says, for each line, whether its note is in the vault once the
 * change is done (a removed note, and a note a merge joined: whether it was; a request to unlock: still). Pure, and free of imports that read anything, so
 * the reader of notices (messages/read.ts) may render a notice again once its card has been decided.
 */

/** A notice's lines: what each says, whether its note is in the vault, and — only when a merge was applied — which are the notes it joined. */
export interface NoticeLines {
  lines: string[];
  vaultLines: boolean[];
  /** One per line, true for a `原来：…` line (a note the merge above it joined: part of that merge's line); absent when there is none. */
  sourceLines?: boolean[];
}

/**
 * A merge's lines, a dream's or a review's alike: `要合并成：…` while it waits; once done `合并了 {k} 条：…` (k the notes it joined), and
 * under it each note it joined as it was, `原来：…` (the one written into first, then the removed ones), with whether that note was in
 * the vault — what a merge kept is there to see, and what its 撤销 brings back. Those lines are marked (`sources`) by where they are, never
 * by their text: a note's own text may begin with 原来： too.
 */
function mergeLines(s: StoredOp, pending: boolean, lines: string[], vaultLines: boolean[], sources: Set<number>): void {
  if (pending) {
    lines.push(`要合并成：${s.after}`);
    vaultLines.push(s.vaultAfter === true);
    return;
  }
  lines.push(`合并了 ${1 + s.removed!.length} 条：${s.after}`);
  vaultLines.push(s.vaultAfter === true);
  for (const [text, vault] of [[s.before, s.vaultBefore === true] as const, ...s.removed!.map((r) => [r.text, r.vault] as const)]) {
    sources.add(lines.length);
    lines.push(`原来：${text}`);
    vaultLines.push(vault);
  }
}

/** The notice's lines with the merges' source lines marked, when there are any. */
const marked = (lines: string[], vaultLines: boolean[], sources: ReadonlySet<number>): NoticeLines =>
  sources.size === 0 ? { lines, vaultLines } : { lines, vaultLines, sourceLines: lines.map((_, i) => sources.has(i)) };

export function linesOf(ops: ReadonlyArray<StoredOp>, pending = false): NoticeLines {
  const lines: string[] = [];
  const vaultLines: boolean[] = [];
  const sources = new Set<number>();
  for (const s of ops) {
    switch (s.op) {
      // A review's merge (its notes joined, pipeline.ts) is told as a dream's is.
      case "merge":
        mergeLines(s, pending, lines, vaultLines, sources);
        break;
      case "add":
        lines.push(`${pending ? "要记住：" : "记住了："}${s.after}`);
        vaultLines.push(s.vaultAfter === true);
        break;
      case "replace":
        lines.push(`${pending ? "要改成：" : "改成了："}${s.after}`);
        vaultLines.push(s.vaultAfter === true);
        break;
      case "remove":
        lines.push(`${pending ? "要忘掉：" : "忘掉了："}${s.before}`);
        vaultLines.push(s.vaultBefore === true);
        break;
      case "lock":
        lines.push(`${pending ? "要锁进保险箱：" : "锁进了保险箱："}${s.after}`);
        vaultLines.push(true);
        break;
      case "unlock":
        lines.push(s.before ?? "");
        vaultLines.push(true);
        break;
    }
  }
  return marked(lines, vaultLines, sources);
}

/** A dream's lines (`linesOf`'s counterpart): `合并了 {k} 条：…` with its `原来：…` / `要合并成：…`, `改成了：…`, `拆成了：{part}；{part}` / `要拆成：…`, `锁进了保险箱：…`. A split's mark: whether any part is in the vault. */
export function dreamLines(ops: ReadonlyArray<StoredOp>, pending = false): NoticeLines {
  const lines: string[] = [];
  const vaultLines: boolean[] = [];
  const sources = new Set<number>();
  for (const s of ops) {
    if (s.op === "merge") {
      mergeLines(s, pending, lines, vaultLines, sources);
    } else if (s.op === "replace") {
      lines.push(`${pending ? "要改成：" : "改成了："}${s.after}`);
      vaultLines.push(s.vaultAfter === true);
    } else if (s.op === "split") {
      lines.push(`${pending ? "要拆成：" : "拆成了："}${s.parts!.map((p) => p.text).join("；")}`);
      vaultLines.push(s.parts!.some((p) => p.vault));
    } else if (s.op === "lock") {
      lines.push(`${pending ? "要锁进保险箱：" : "锁进了保险箱："}${s.after}`);
      vaultLines.push(true);
    }
  }
  return marked(lines, vaultLines, sources);
}
