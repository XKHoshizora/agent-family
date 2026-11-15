import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { convTitle, convSubtitle, visibilityNote, publishBlock } from "../state/selectors.js";
import { ConvAvatar, Btn, IconBtn } from "../ui/primitives.jsx";
import { MessageItem } from "./Messages.jsx";
import { Search, Menu, Eye, ChevronLeft, X } from "../icons.js";

import { Composer } from "./Composer.jsx";

export function ChatView({ conv }) {
  const { state, dispatch } = useStore();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const endRef = useRef(null);
  const block = publishBlock(state, conv);
  const note = visibilityNote(state, conv);
  const group = conv.type === "group" || conv.type === "mixed" || conv.type === "agentGroup";
  const q = query.trim();
  const messages = q ? conv.messages.filter((x) => (x.text || "").toLowerCase().includes(q.toLowerCase())) : conv.messages;

  useEffect(() => {
    setSearching(false);
    setQuery("");
  }, [conv.id]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conv.id, conv.messages.length]);

  return (
    <section className="chat" aria-label={convTitle(state, conv)}>
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
      {note && (
        <div className="vis-banner">
          <Eye size={18} aria-hidden="true" /> {note}
        </div>
      )}
      <ol className="messages">
        {q && messages.length === 0 && <li className="rows-empty" role="status">没有找到相关消息，请换个关键词</li>}
        {messages.map((msg) => (
          <MessageItem key={msg.id} msg={msg} conv={conv} onReply={block ? () => dispatch({ type: "toast", text: block.text }) : setReplyTo} />
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ol>

      <Composer conv={conv} block={block} replyTo={replyTo} setReplyTo={setReplyTo} />
    </section>
  );
}
