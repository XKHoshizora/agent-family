// A room of the memory palace: 关于我 (what my Agents know about me, shared; on the Settings page) and an Agent's own notes
// (on its page) are the same component. Its open entries come first, then the vault block, set apart: what is in the vault
// is never given to the model in a group. Each row saves itself (as AgentAppellations' rows do): nothing here has a
// 保存 for the room as a whole.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { formatAt } from "../data/viewmodel.js";
import { Lock, Pencil, Trash2 } from "../icons.js";
import { Btn, IconBtn, Tag } from "../ui/primitives.jsx";
import { useRowWrite } from "./useAction.js";

/** Characters as the service counts them: code points. */
const chars = (text) => [...text].length;

/** `已用 N%` of a room: rounded, never above 100. */
export const usedPercent = (used, limit) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100);

/** From this many mentions a note is 常提起 (the service counts every time it was said again). */
const OFTEN = 3;

/** `{date} · {source}`: where an entry was learned. The service reports an origin that was deleted as manual. */
function sourceLine(note, agentName) {
  const { kind, title } = note.source;
  let source;
  if (kind === "agent") source = `和${title ?? agentName ?? "Agent"}的对话`;
  else if (kind === "group") source = title ?? "已离开的群";
  else source = note.origin === "owner" ? "手动添加" : "来源已删除";
  return `${formatAt(Date.parse(note.createdAt), Date.now())} · ${source}`;
}

/**
 * A room as the service holds it (`GET`), read when the page opens and again after every write (`reload`, which keeps
 * what is shown meanwhile and says whether it got the room). `agentId` null is 关于我. `failure` is the sentence of the last
 * read that failed; `stale` says the last read failed (a page with a room shows `StaleLine`, one without shows `failure`).
 * `capLeft(n)` takes the room's remaining characters from a refusal ("room_full") at once.
 */
export function useMemoryRoom(agentId = null) {
  const { actions } = useStore();
  const [room, setRoom] = useState(null);
  const [failure, setFailure] = useState("");
  const [stale, setStale] = useState(false);
  const alive = useRef(true);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const res = await actions.loadMemoryRoom(agentId);
    if (!alive.current || mine !== latest.current) return true;
    if (res.ok && res.value) {
      setRoom(res.value);
      setFailure("");
      setStale(false);
      return true;
    }
    setFailure(res.ok ? "读取失败了，请稍后再试。" : res.text);
    setStale(true);
    return false;
  }, [actions, agentId]);
  const capLeft = useCallback((left) => setRoom((r) => (r ? { ...r, used: Math.max(0, r.limit - left) } : r)), []);
  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  return { room, failure, stale, reload, capLeft };
}

/**
 * The writes of one row (`useRowWrite`) with what the rooms do after them: the room is read again (the row stays locked
 * meanwhile), a note gone elsewhere is read again, and a full room's remaining characters are taken at once.
 */
export function useNoteWrite(memory) {
  return useRowWrite({
    after: memory.reload,
    refused: (refusal) => {
      const { code, left } = refusal.error ?? {};
      if (code === "not_found") memory.reload();
      if (code === "room_full" && Number.isFinite(left)) memory.capLeft(left);
    },
  });
}

/** Where the focus goes once the room has been read again: `set(find)` where `find()` gives the element; `set(null)` forgets it. */
export function useRefocus(room) {
  const next = useRef(null);
  useEffect(() => {
    const find = next.current;
    if (!find) return;
    next.current = null;
    find()?.focus();
  }, [room]);
  return (find) => {
    next.current = find;
  };
}

/** The first action of the row of `item` in `container`, or what `fallback` gives. */
export const firstActionOf = (container, item, fallback) => () =>
  (item && container.current?.querySelector(`[data-memory-id="${item.id}"] .memory-actions button:not(:disabled)`)) || fallback?.() || null;

/** The row to look at once `item` has left `list`: the next one, else the one before. */
export const neighbourOf = (list, item) => list[list.indexOf(item) + 1] ?? list[list.indexOf(item) - 1] ?? null;

/** Said under a room when a change was saved but the room could not be read again. */
export function StaleLine({ memory }) {
  if (!memory.stale) return null;
  return (
    <p className="muted memory-stale">
      刚才的改动已保存，但列表没刷新出来。 <Btn small onClick={memory.reload}>重试</Btn>
    </p>
  );
}

/**
 * 删除 in two steps, in place: the button turns into 确定删除？ (a second click deletes); it turns back by itself after four
 * seconds, on blur and on Escape. `icon` shows the trash can while idle, otherwise the word.
 */
export function DeleteButton({ onDelete, disabled, describedBy, icon = false }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return undefined;
    const timer = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(timer);
  }, [sure]);
  const click = () => {
    if (!sure) return setSure(true);
    setSure(false);
    onDelete();
  };
  const common = {
    type: "button",
    disabled,
    "aria-describedby": describedBy,
    onClick: click,
    onBlur: () => setSure(false),
    onKeyDown: (e) => e.key === "Escape" && setSure(false),
  };
  if (sure) {
    return (
      <button {...common} className="btn btn-danger btn-sm" aria-label="确定删除">
        确定删除？
      </button>
    );
  }
  return icon ? (
    <button {...common} className="icon-btn" aria-label="删除" title="删除">
      <Trash2 size={16} aria-hidden="true" />
    </button>
  ) : (
    <button {...common} className="btn btn-ghost btn-sm">
      删除
    </button>
  );
}

/** What a text needs of the room: how many characters it may have (`left`) and whether it has more. */
const tooLong = (text, left) => chars(text.trim()) > left;
const leftText = (left) => `只剩 ${Math.max(0, left)} 个字了，这条太长。`;

/** The add row at the top of a room: a box and 添加; what was typed stays when the service refuses it. */
function AddRow({ agentId, left, memory, inputRef }) {
  const { actions } = useStore();
  const { pending, error, write } = useNoteWrite(memory);
  const [text, setText] = useState("");
  const typed = text.trim();
  const over = tooLong(typed, left);
  const submit = async (event) => {
    event.preventDefault();
    if (!typed || over || pending) return;
    if (await write(() => actions.addMemoryNote(agentId, { text: typed }))) setText("");
  };
  return (
    <form className="memory-add" onSubmit={submit}>
      <div className="memory-add-line">
        <input ref={inputRef} aria-label="新的笔记" value={text} onChange={(e) => setText(e.target.value)} placeholder="手动加一条" autoComplete="off" readOnly={pending} />
        <Btn type="submit" small variant="primary" disabled={pending || !typed || over}>添加</Btn>
      </div>
      {over && <p className="field-msg">{leftText(left)}</p>}
      {error && <p className="field-msg" role="alert">{error}</p>}
    </form>
  );
}

/** One entry: its text (or the box it is edited in), the source line, and its actions. In the vault the lock is 取出. */
function NoteRow({ agentId, agentName, note, left, memory, leaving }) {
  const { actions } = useStore();
  const { pending, error, write } = useNoteWrite(memory);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const editButton = useRef(null);
  const returnFocus = useRef(false);
  const typed = text.trim();
  const textId = `memory-text-${note.id}`;
  // Its own characters are the room it may use again.
  const over = tooLong(typed, left + chars(note.text));

  // Back from the box: the focus is on this row's 编辑 again.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  const closeEdit = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  const open = () => {
    setText(note.text);
    setEditing(true);
  };
  const save = async (event) => {
    event.preventDefault();
    if (!typed || over || pending) return;
    if (typed === note.text) return closeEdit();
    if (await write(() => actions.patchMemoryNote(agentId, note.id, { text: typed }))) closeEdit();
  };
  /** A write that takes the row out of its list: the focus goes to its neighbour once the room is read again. */
  const leave = async (call) => {
    leaving(note);
    if (!(await write(call))) leaving(null);
  };

  return (
    <li className="memory-row" data-memory-id={note.id}>
      <div className="memory-body">
        {editing ? (
          <form id={`edit-${note.id}`} onSubmit={save}>
            <input aria-label="编辑这条笔记" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" readOnly={pending} autoFocus />
          </form>
        ) : (
          <p className="memory-text" id={textId}>{note.text}</p>
        )}
        <p className="memory-source muted">
          {sourceLine(note, agentName)}
          {note.strength >= OFTEN && <Tag tone="muted">常提起</Tag>}
          {note.vault && note.unsure && <Tag tone="muted">拿不准，先锁上了</Tag>}
        </p>
        {editing && over && <p className="field-msg">{leftText(left + chars(note.text))}</p>}
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="memory-actions">
        {editing ? (
          <>
            <Btn small variant="primary" type="submit" form={`edit-${note.id}`} disabled={pending || !typed || over}>保存</Btn>
            <Btn small disabled={pending} onClick={closeEdit}>取消</Btn>
          </>
        ) : (
          <>
            {note.vault ? (
              <Btn small disabled={pending} aria-describedby={textId} onClick={() => leave(() => actions.patchMemoryNote(agentId, note.id, { vault: false }))}>取出</Btn>
            ) : (
              <IconBtn label="放进保险箱" disabled={pending} aria-describedby={textId} onClick={() => leave(() => actions.patchMemoryNote(agentId, note.id, { vault: true }))}>
                <Lock size={16} aria-hidden="true" />
              </IconBtn>
            )}
            <IconBtn ref={editButton} label="编辑" disabled={pending} aria-describedby={textId} onClick={open}>
              <Pencil size={16} aria-hidden="true" />
            </IconBtn>
            <DeleteButton icon disabled={pending} describedBy={textId} onDelete={() => leave(() => actions.deleteMemoryNote(agentId, note.id))} />
          </>
        )}
      </div>
    </li>
  );
}

/**
 * One room. `agentId` null is 关于我 (shared by all my Agents); an Agent's id is its own notes. `memory` is
 * `useMemoryRoom`'s answer (the Agent's page reads both its rooms in one request); its room must be there.
 */
export function MemoryRoom({ agentId = null, agentName, title, helper, memory }) {
  const { room } = memory;
  const section = useRef(null);
  const addBox = useRef(null);
  const refocus = useRefocus(room);
  const left = room.limit - room.used;
  const open = room.notes.filter((n) => !n.vault);
  const vault = room.notes.filter((n) => n.vault);
  const leaving = (note) =>
    refocus(note ? firstActionOf(section, neighbourOf(note.vault ? vault : open, note), () => addBox.current) : null);
  const row = (note) => <NoteRow key={note.id} agentId={agentId} agentName={agentName} note={note} left={left} memory={memory} leaving={leaving} />;
  return (
    <section className="memory-room" aria-label={title} ref={section}>
      <header className="memory-head">
        <h3>{title}</h3>
        <span className="muted">已用 {usedPercent(room.used, room.limit)}%</span>
      </header>
      {helper && <p className="muted">{helper}</p>}
      {agentId !== null && room.fits === false && <p className="muted">这个模型的上下文较小，每次只带得下一部分记忆。</p>}
      <StaleLine memory={memory} />
      <AddRow agentId={agentId} left={left} memory={memory} inputRef={addBox} />
      <ul className="memory-rows memory-open">
        {open.map(row)}
        {open.length === 0 && <li className="rows-empty">还没有记下的内容</li>}
      </ul>
      <div className="memory-vault">
        <h4>保险箱 · {vault.length} 条 · 群里的 Agent 拿不到</h4>
        <ul className="memory-rows">{vault.map(row)}</ul>
      </div>
    </section>
  );
}
