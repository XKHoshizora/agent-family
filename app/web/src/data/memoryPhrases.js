// The sentences of the memory chip (what the owner reads when their Agent napped or dreamed). A sentence is one of a small
// closed set, picked by a stable hash of the notice's id: the same notice reads the same on every render and device, and
// nothing is random at render time. More sentences are added by adding to a set; `{name}` is the Agent, `{n}` the count.

export const RECORD = [
  ({ name, n }) => `${name}小憩时记下了 ${n} 件事`,
  ({ name, n }) => `${name}歇了一会儿，记住了 ${n} 件事`,
  ({ name, n }) => `${name}趁着小憩，把 ${n} 件事记了下来`,
];
export const TIDY = [({ name }) => `${name}小憩时理了理记忆`];
export const HEARSAY = [({ name, n }) => `${name}小憩时想起听来的 ${n} 件事`];
export const DREAM = [
  ({ name, n }) => `${name}入梦时整理了 ${n} 条记忆`,
  ({ name, n }) => `${name}昨夜入梦，把 ${n} 条记忆理顺了`,
  ({ name, n }) => `${name}在梦里收拾了 ${n} 条记忆`,
];

/** A stable index below `size` for `id` (FNV-1a over its code points). */
export function pickIndex(id, size) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % size;
}

const startsWith = (prefix) => (line) => line.startsWith(prefix);
const isHearsay = startsWith("听说：");
const isTidy = (line) => line.startsWith("忘掉了：") || line.startsWith("锁进了保险箱：") || line.startsWith("取出来：") || line.startsWith("合并了 ");
const isRecord = (line) => line.startsWith("记住了：") || line.startsWith("改成了：");
/** A line under a merge that says what it merged (`原来：…`, one per note it joined): part of the merge's line, never a change of its own. */
export const isMergedSource = startsWith("原来：");

/**
 * The sentence of an applied notice: `{name, changeId, phase, lines, count, full}`. `phase` "dream" has its own set; a rest
 * with only hearsay has its own; one of only tidying (forgetting, locking, taking out, merging) or of tidying mixed with records counts
 * only the records. The lines that list what a merge joined (`原来：…`) are not counted, and `count` (the number of lines) without them.
 */
export function memorySentence({ name, changeId, phase, lines: all, count, full }) {
  const lines = all.filter((line) => !isMergedSource(line));
  let n = (Number.isFinite(count) ? count : all.length) - (all.length - lines.length);
  let set;
  if (lines.length === 0 && full) return `${name}的记忆宫殿快满了`;
  if (phase === "dream") set = DREAM;
  else if (lines.length > 0 && lines.every(isHearsay)) set = HEARSAY;
  else if (lines.length === 0 || lines.every(isTidy)) set = TIDY;
  else if (lines.some(isTidy) || lines.some(isHearsay)) {
    // Mixed: only the lines that record are counted; with none, it was tidying.
    n = lines.filter(isRecord).length;
    set = n > 0 ? RECORD : TIDY;
  } else set = RECORD;
  const sentence = set[pickIndex(changeId, set.length)]({ name, n });
  return full ? `${sentence} · 快满了` : sentence;
}
