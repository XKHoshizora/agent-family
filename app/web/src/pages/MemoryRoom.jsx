// A room of the memory palace: 关于我 (what my Agents know about me, shared; on the Settings page) and an Agent's own notes
// (on its page) are the same component. Its open entries come first, then the vault block, set apart: what is in the vault
// is never given to the model in a group. Each row saves itself (as AgentAppellations' rows do): nothing here has a
// 保存 for the room as a whole.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { formatAt } from "../data/viewmodel.js";
import { Lock, Pencil, Trash2 } from "../icons.js";
import { Btn, IconBtn, Tag } from "../ui/primitives.jsx";
import { refusalText, settled, useAction } from "./useAction.js";

/** Characters as the service counts them: code points. */
const chars = (text) => [...text].length;

/** `已用 N%` of a room: rounded, never above 100. */
export const usedPercent = (used, limit) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100);

/** `{date} · {source}`: where an entry was learned. */
function sourceLine(note, agentName) {
  const { kind, title } = note.source;
  const source = kind === "agent" ? `和${title ?? agentName ?? "Agent"}的对话` : kind === "group" ? (title ?? "已离开的群") : "手动添加";
  return `${formatAt(Date.parse(note.createdAt), Date.now())} · ${source}`;
}

/**
 * A room as the service holds it (`GET`), read when the page opens and again after every write (`reload`, which keeps
 * what is shown meanwhile). `agentId` null is 关于我. `failure` is the sentence of the last read that failed (a page
 * with no room yet shows it).
 * @returns {{room: object|null, failure: string, reload: () => Promise<void>}}
 */
export function useMemoryRoom(agentId = null) {
  const { actions } = useStore();
  const [room, setRoom] = useState(null);
  const [failure, setFailure] = useState("");
  const alive = useRef(true);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const res = await actions.loadMemoryRoom(agentId);
    if (!alive.current || mine !== latest.current) return;
    if (res.ok && res.value) {
      setRoom(res.value);
      setFailure("");
    } else {
      setFailure(res.ok ? "读取失败了，请稍后再试。" : res.text);
    }
  }, [actions, agentId]);
  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  return { room, failure, reload };
}

/**
 * The writes of one row, one at a time: `pending` says one is running, `error` is the sentence of the last refusal (shown
 * under the row). `write(call)` runs an action and reads the room again after it (a note gone elsewhere is read again, too);
 * it says whether the service took it.
 */
export function useRowWrite(reload) {
  const { busy, run } = useAction();
  const [error, setError] = useState("");
  const write = async (call) => {
    setError("");
    const res = await run("write", () => settled(call()), () => "");
    if (res.ok) {
      await reload();
    } else if (res.error?.code !== "busy_here") {
      setError(refusalText(res.error));
      if (res.error?.error?.code === "not_found") reload();
    }
    return res.ok;
  };
  return { pending: busy !== null, error, write };
}

/** What a text needs of the room: how many characters it may have (`left`) and whether it has more. */
const tooLong = (text, left) => chars(text.trim()) > left;
const leftText = (left) => `只剩 ${Math.max(0, left)} 个字了，这条太长。`;

/** The add row at the top of a room: a box and 添加; what was typed stays when the service refuses it. */
function AddRow({ agentId, left, reload }) {
  const { actions } = useStore();
  const { pending, error, write } = useRowWrite(reload);
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
        <input aria-label="新的笔记" value={text} onChange={(e) => setText(e.target.value)} placeholder="手动加一条" autoComplete="off" readOnly={pending} />
        <Btn type="submit" small variant="primary" disabled={pending || !typed || over}>添加</Btn>
      </div>
      {over && <p className="field-msg">{leftText(left)}</p>}
      {error && <p className="field-msg" role="alert">{error}</p>}
    </form>
  );
}

/** One entry: its text (or the box it is edited in), the source line, and its actions. In the vault the lock is 取出. */
function NoteRow({ agentId, agentName, note, left, reload }) {
  const { actions } = useStore();
  const { pending, error, write } = useRowWrite(reload);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const typed = text.trim();
  // Its own characters are the room it may use again.
  const over = tooLong(typed, left + chars(note.text));

  const open = () => {
    setText(note.text);
    setEditing(true);
  };
  const save = async (event) => {
    event.preventDefault();
    if (!typed || over || pending) return;
    if (typed === note.text) return setEditing(false);
    if (await write(() => actions.patchMemoryNote(agentId, note.id, { text: typed }))) setEditing(false);
  };
  const lock = (vault) => write(() => actions.patchMemoryNote(agentId, note.id, { vault }));

  return (
    <li className="memory-row">
      <div className="memory-body">
        {editing ? (
          <form id={`edit-${note.id}`} onSubmit={save}>
            <input aria-label="编辑这条笔记" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" readOnly={pending} autoFocus />
          </form>
        ) : (
          <p className="memory-text">{note.text}</p>
        )}
        <p className="memory-source muted">
          {sourceLine(note, agentName)}
          {note.vault && note.unsure && <Tag tone="muted">拿不准，先锁上了</Tag>}
        </p>
        {editing && over && <p className="field-msg">{leftText(left + chars(note.text))}</p>}
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="memory-actions">
        {editing ? (
          <>
            <Btn small variant="primary" type="submit" form={`edit-${note.id}`} disabled={pending || !typed || over}>保存</Btn>
            <Btn small disabled={pending} onClick={() => setEditing(false)}>取消</Btn>
          </>
        ) : (
          <>
            {note.vault ? (
              <Btn small disabled={pending} onClick={() => lock(false)}>取出</Btn>
            ) : (
              <IconBtn label="放进保险箱" disabled={pending} onClick={() => lock(true)}>
                <Lock size={16} aria-hidden="true" />
              </IconBtn>
            )}
            <IconBtn label="编辑" disabled={pending} onClick={open}>
              <Pencil size={16} aria-hidden="true" />
            </IconBtn>
            <IconBtn label="删除" disabled={pending} onClick={() => write(() => actions.deleteMemoryNote(agentId, note.id))}>
              <Trash2 size={16} aria-hidden="true" />
            </IconBtn>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * One room. `agentId` null is 关于我 (shared by all my Agents); an Agent's id is its own notes. `room` and `reload` come from
 * `useMemoryRoom` (the Agent's page reads both its rooms in one request).
 */
export function MemoryRoom({ agentId = null, agentName, title, helper, room, reload }) {
  const left = room.limit - room.used;
  const open = room.notes.filter((n) => !n.vault);
  const vault = room.notes.filter((n) => n.vault);
  const row = (note) => <NoteRow key={note.id} agentId={agentId} agentName={agentName} note={note} left={left} reload={reload} />;
  return (
    <section className="memory-room" aria-label={title}>
      <header className="memory-head">
        <h3>{title}</h3>
        <span className="muted">已用 {usedPercent(room.used, room.limit)}%</span>
      </header>
      {helper && <p className="muted">{helper}</p>}
      <AddRow agentId={agentId} left={left} reload={reload} />
      <ul className="memory-rows memory-open">
        {open.map(row)}
        {open.length === 0 && <li className="rows-empty">还没有记下的内容。</li>}
      </ul>
      <div className="memory-vault">
        <h4>保险箱 · {vault.length} 条 · 群里的 Agent 拿不到</h4>
        <ul className="memory-rows">{vault.map(row)}</ul>
      </div>
    </section>
  );
}
