import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { convTitle, convSubtitle, publishBlock } from "../state/selectors.js";
import { ConvAvatar, Btn, IconBtn, Notice } from "../ui/primitives.jsx";
import { MessageItem } from "./Messages.jsx";
import { Search, Menu, ChevronLeft, X } from "../icons.js";

import { Composer } from "./Composer.jsx";
import { droppedFiles, useSendFiles } from "./useSendFiles.js";

/** This close to the bottom the list counts as "at the newest message" and follows new ones. */
const BOTTOM_SLACK_PX = 48;
/** This close to the top, the page of older messages is loaded. */
const TOP_SLACK_PX = 120;
/** The newest message is marked read once the open chat has been in view this long. */
export const READ_DELAY_MS = 500;
/** After older history failed to load, scrolling asks again only after this long. */
const OLDER_RETRY_MS = 3000;

const newestSeqOf = (messages) => messages.reduce((max, m) => (Number.isSafeInteger(m.seq) && m.seq > max ? m.seq : max), 0);
/** The person can see this tab: it is visible and the window has focus. */
const inView = () => document.visibilityState === "visible" && document.hasFocus();
/** The element is laid out: not inside a `display: none` pane (the phone layout hides the chat while the list shows). */
const onScreen = (element) => Boolean(element) && element.getClientRects().length > 0;
const firstMessageNode = (list) => [...list.children].find((li) => li.dataset.msg);
const topWithin = (node, list) => node.getBoundingClientRect().top - list.getBoundingClientRect().top;

export function ChatView({ conv }) {
  const { state, dispatch, actions } = useStore();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  /** Bumped when the person may have started looking (tab shown, window focused, scrolled to the newest). */
  const [attention, setAttention] = useState(0);
  const listRef = useRef(null);
  const atBottom = useRef(true);
  const lastSeen = useRef(null);
  /** While an older page loads: the first message on screen and where it was, to keep it in place. */
  const anchor = useRef(null);
  /** The conversation whose older page is loading, and when loading failed per conversation. */
  const older = useRef({ busy: null, failedAt: new Map() });
  const readFailed = useRef(null);
  const [dropping, setDropping] = useState(false);
  const block = publishBlock(state, conv);
  const group = conv.type === "group";
  const q = query.trim();
  const messages = q ? conv.messages.filter((x) => (x.text || "").toLowerCase().includes(q.toLowerCase())) : conv.messages;
  const firstId = messages[0]?.id ?? null;
  const last = messages[messages.length - 1] ?? null;
  const newestSeq = newestSeqOf(conv.messages);

  useEffect(() => {
    setSearching(false);
    setQuery("");
  }, [conv.id]);

  // A chat opens at its newest message. Opening it is also the person asking again for history that failed.
  useLayoutEffect(() => {
    atBottom.current = true;
    anchor.current = null;
    readFailed.current = null;
    older.current.failedAt.delete(conv.id);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conv.id]);

  // After the list changed: an older page keeps what was on screen where it was; otherwise a list that was at
  // the newest message stays there, and so does one where I just sent something. Scrolled up: no jump.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const mineNew = last !== null && last.id !== lastSeen.current && last.from === ME && last.seq === null;
    lastSeen.current = last?.id ?? null;
    const held = anchor.current;
    if (held && held.convId === conv.id && firstId !== held.id) {
      anchor.current = null;
      const node = [...list.children].find((li) => li.dataset.msg === held.id);
      if (node) list.scrollTop += topWithin(node, list) - held.top;
      return;
    }
    if (atBottom.current || mineNew) {
      list.scrollTop = list.scrollHeight;
      atBottom.current = true;
    }
  }, [conv.id, firstId, last?.id, messages.length]);

  /**
   * Loads the page before the oldest held message. `byScroll`: the person scrolled to the top — after a failure
   * that asks again once OLDER_RETRY_MS has passed. Otherwise (a history too short to scroll) a failure stops the
   * automatic path for this conversation until the person scrolls or opens the chat again, so nothing repeats on
   * its own while the service is unreachable.
   */
  function loadOlder({ byScroll }) {
    const list = listRef.current;
    const convId = conv.id;
    const { busy, failedAt } = older.current;
    if (!list || q || !conv.hasOlder || busy === convId) return;
    if (failedAt.has(convId) && (!byScroll || Date.now() - failedAt.get(convId) < OLDER_RETRY_MS)) return;
    const first = firstMessageNode(list);
    anchor.current = first ? { convId, id: first.dataset.msg, top: topWithin(first, list) } : null;
    older.current.busy = convId;
    actions.loadOlder(convId).then((res) => {
      if (older.current.busy === convId) older.current.busy = null;
      if (res.ok) older.current.failedAt.delete(convId);
      else older.current.failedAt.set(convId, Date.now());
      // Nothing was added: nothing to keep in place.
      if ((!res.ok || res.loaded === 0) && anchor.current?.convId === convId) anchor.current = null;
      const quiet = ["stale", "stopped"].includes(res.error?.code) || [401, 404].includes(res.error?.status);
      if (!res.ok && !quiet) dispatch({ type: "toast", text: "更早的消息加载失败，请稍后再试" });
    });
  }

  // History shorter than the list's height cannot be scrolled: ask for older messages straight away (once per
  // page; not again on its own after a failure, see loadOlder).
  useEffect(() => {
    const list = listRef.current;
    if (list && conv.hasOlder && list.clientHeight > 0 && list.scrollHeight <= list.clientHeight) loadOlder({ byScroll: false });
  }, [conv.id, conv.hasOlder, conv.messages.length, q]);

  function onScroll() {
    const list = listRef.current;
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight <= BOTTOM_SLACK_PX;
    if (bottom && !atBottom.current) {
      readFailed.current = null;
      setAttention((n) => n + 1);
    }
    atBottom.current = bottom;
    if (list.scrollTop <= TOP_SLACK_PX) loadOlder({ byScroll: true });
  }

  useEffect(() => {
    const look = () => {
      readFailed.current = null;
      setAttention((n) => n + 1);
    };
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("focus", look);
    };
  }, []);

  // Mark read up to the newest message once the chat has been in view for a moment: the tab is visible, the
  // window focused, the chat laid out on screen (not behind the phone layout's list pane), the list at the newest
  // message, no search filtering it. A failed attempt is not repeated until something changes (a new message,
  // the person looks again, the chat pane is shown again).
  const pane = state.nav.pane;
  useEffect(() => {
    if (conv.unread === 0 || newestSeq === 0 || q) return undefined;
    const key = `${conv.id}:${newestSeq}`;
    if (readFailed.current === key) return undefined;
    const timer = setTimeout(() => {
      // (A failure re-renders before it is recorded below, so this timer may predate it: check again.)
      if (readFailed.current === key || !inView() || !onScreen(listRef.current) || !atBottom.current) return;
      actions.markRead(conv.id, newestSeq).then((res) => {
        if (!res.ok) readFailed.current = key;
      });
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conv.id, conv.unread, newestSeq, q, attention, pane, actions]);

  // Files dropped anywhere on the chat are sent like picked ones (nothing is uploaded where sending is held).
  const sendFiles = useSendFiles(conv, block);
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const dropHandlers = {
    onDragOver: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!block) setDropping(true); // a chat that cannot send does not invite the drop (it still answers it with the hold notice)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false);
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      sendFiles(droppedFiles(e.dataTransfer));
    },
  };

  return (
    <section className={`chat${dropping ? " dropping" : ""}`} aria-label={convTitle(state, conv)} {...dropHandlers}>
      <header className="chat-head">
        <IconBtn label="返回列表" className="only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}><ChevronLeft size={22} /></IconBtn>
        <ConvAvatar conv={conv} size={56} />
        <div className="chat-title">
          <h2>{convTitle(state, conv)}</h2>
          <p>{convSubtitle(state, conv)}</p>
        </div>
        <div className="chat-head-actions">
          <IconBtn label="搜索本会话" className="boxed" aria-pressed={searching} onClick={() => (setSearching(!searching), setQuery(""))}><Search size={22} /></IconBtn>
          {group ? (
            <Btn className="boxed" onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "members" } })}>群资料</Btn>
          ) : null}
          <IconBtn label="会话资料" className="boxed" aria-pressed={state.nav.detailsOpen} onClick={() => dispatch({ type: "nav", patch: { detailsOpen: !state.nav.detailsOpen } })}><Menu size={22} /></IconBtn>
        </div>
      </header>

      {searching && (
        <div className="chat-search">
          <Search size={16} aria-hidden="true" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"){setQuery("");setSearching(false);}}} placeholder="在本会话中搜索" aria-label="在本会话中搜索" />
          <span className="muted">{q ? `${messages.length} 条结果` : ""}</span>
          <IconBtn label="关闭会话搜索" onClick={()=>{setQuery("");setSearching(false);}}><X size={16}/></IconBtn>
        </div>
      )}
      {block && (
        <Notice tone="pause">
          <strong>{block.text}</strong>
        </Notice>
      )}
      <ol className="messages" ref={listRef} onScroll={onScroll}>
        {q && messages.length === 0 && <li className="rows-empty" role="status">没有找到相关消息，请换个关键词</li>}
        {messages.map((msg) => (
          <MessageItem key={msg.id} msg={msg} conv={conv} onReply={block ? () => dispatch({ type: "toast", text: block.text }) : setReplyTo} />
        ))}
        <li aria-hidden="true" />
      </ol>

      <Composer conv={conv} block={block} replyTo={replyTo} setReplyTo={setReplyTo} />
    </section>
  );
}
