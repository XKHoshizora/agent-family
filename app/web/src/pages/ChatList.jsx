import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { convTitle, entity, lastPreview, TYPE_LABEL, otherMember } from "../state/selectors.js";
import { ConvAvatar, IconBtn } from "../ui/primitives.jsx";
import { Plus, Search, UserPlus } from "../icons.js";

const FILTERS = [
  ["all", "全部"],
  ["unread", "未读"],
  ["group", "群聊"],
];

export function ListHeader({ title, action }) {
  return (
    <header className="list-head">
      <p className="brand-name">Agent Family</p>
      <div className="list-title">
        <h1>{title}</h1>
        {action}
      </div>
    </header>
  );
}

export function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="search">
      <Search size={18} aria-hidden="true" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function Pills({ options, value, onChange, label }) {
  return (
    <div className="pills" role="tablist" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="tab" tabIndex={value === id ? 0 : -1} aria-selected={value === id} className={value === id ? "active" : ""} onClick={() => onChange(id)} onKeyDown={e=>{
          if (!["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) return;
          e.preventDefault();
          const i=options.findIndex(([key])=>key===id);
          const next=e.key==="Home"?0:e.key==="End"?options.length-1:(i+(e.key==="ArrowRight"?1:-1)+options.length)%options.length;
          onChange(options[next][0]);
          const button=e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next];
          button.focus();button.scrollIntoView({block:"nearest",inline:"nearest"});
        }}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Local filter: the conversation's name, a direct chat's account name (@handle), the last message, or 私聊/群聊. */
function matches(state, conv, q) {
  if (!q) return true;
  const handle = conv.type === "human" ? entity(state, otherMember(conv))?.handle ?? "" : "";
  return [convTitle(state, conv), handle, lastPreview(state, conv), TYPE_LABEL[conv.type] ?? ""].some((text) => text.toLowerCase().includes(q));
}

export function ChatList() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const outside = e => { if(!menuRef.current?.contains(e.target)) setMenu(false); };
    const escape = e => { if(e.key === "Escape") { setMenu(false); menuRef.current?.querySelector('button')?.focus(); } };
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",escape);
    return () => {document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[menu]);
  const q = query.trim().toLowerCase();

  const rows = state.order
    .map((id) => state.convs[id])
    .filter(Boolean)
    .filter((c) => (filter === "unread" ? c.unread > 0 : filter === "group" ? c.type === "group" : true))
    .filter((c) => matches(state, c, q));

  return (
    <>
      <ListHeader
        title="消息"
        action={
          <div className="menu-anchor" ref={menuRef}>
            <IconBtn label="新建" className="boxed" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <Plus size={20} />
            </IconBtn>
            {menu && (
              <div className="menu" aria-label="新建选项">
                <button type="button" onClick={() => (setMenu(false), dispatch({ type: "nav", patch: { section: "contacts", pane: "list", addFriend: true } }))}>
                  <UserPlus size={16} aria-hidden="true" /> 添加好友
                </button>
              </div>
            )}
          </div>
        }
      />
      <SearchBox value={query} onChange={setQuery} placeholder="搜索联系人、群聊" />
      <Pills options={FILTERS} value={filter} onChange={setFilter} label="会话筛选" />
      <ul className="rows">
        {rows.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={`row ${state.nav.convId === c.id ? "active" : ""}`}
              aria-current={state.nav.convId === c.id ? "true" : undefined}
              onClick={() => dispatch({ type: "nav/openConv", convId: c.id })}
            >
              <ConvAvatar conv={c} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{convTitle(state, c)}</span>
                  <time>{c.at}</time>
                </span>
                <span className="row-sub">
                  <span className="row-preview">{lastPreview(state, c)}</span>
                  {c.unread > 0 && <span className="badge inline">{c.unread}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="rows-empty">没有符合条件的会话</li>}
      </ul>
    </>
  );
}
