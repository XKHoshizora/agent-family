import type { StoredOp } from "./apply.ts";

/**
 * What a change tells the owner, line by line (a notice carries these, never the change's own record). Two tenses, because a card
 * that asks first must not read like something already done (`记住` on a line that says `忘掉了` is a trap): a change waiting for the
 * owner's yes is in the future (`要记住：…` / `要改成：…` / `要忘掉：…` / `要锁进保险箱：…`; a dream's `要合并成：…` / `要拆成：…`); one
 * that is done is in the past (`记住了：…` / `改成了：…` / `忘掉了：…` / `锁进了保险箱：…`; `合并了 k 条：…` / `拆成了：…`). A request to
 * take a note out of the vault is the note's text in either. `vaultLines` says, for each line, whether its note is in the vault once the
 * change is done (a removed note: whether it was; a request to unlock: still). Pure, and free of imports that read anything, so
 * the reader of notices (messages/read.ts) may render a notice again once its card has been decided.
 */

export function linesOf(ops: ReadonlyArray<StoredOp>, pending = false): { lines: string[]; vaultLines: boolean[] } {
  const lines: string[] = [];
  const vaultLines: boolean[] = [];
  for (const s of ops) {
    switch (s.op) {
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
  return { lines, vaultLines };
}

/** A dream's lines (`linesOf`'s counterpart): `合并了 {k} 条：…` / `要合并成：…`, `改成了：…`, `拆成了：{part}；{part}` / `要拆成：…`, `锁进了保险箱：…`. A split's mark: whether any part is in the vault. */
export function dreamLines(ops: ReadonlyArray<StoredOp>, pending = false): { lines: string[]; vaultLines: boolean[] } {
  const lines: string[] = [];
  const vaultLines: boolean[] = [];
  for (const s of ops) {
    if (s.op === "merge") {
      lines.push(pending ? `要合并成：${s.after}` : `合并了 ${1 + s.removed!.length} 条：${s.after}`);
      vaultLines.push(s.vaultAfter === true);
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
  return { lines, vaultLines };
}
