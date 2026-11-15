import React, { useEffect, useRef } from "react";
import { StoreProvider, useStore } from "./data/store.jsx";
import { unreadTotal } from "./state/selectors.js";
import { ME } from "./data/identities.js";
import { Avatar, BrandMark } from "./ui/primitives.jsx";
import { MessageCircle, Users, Bot, Settings } from "./icons.js";
import { ChatList } from "./pages/ChatList.jsx";
import { ChatView } from "./pages/ChatView.jsx";
import { GroupProfile } from "./pages/GroupProfile.jsx";
import { DetailsPanel } from "./pages/DetailsPanel.jsx";
import { ContactsList, ContactCard } from "./pages/Contacts.jsx";
import { AgentsList, AgentMain } from "./pages/Agents.jsx";
import { SettingsList, SettingsMain } from "./pages/Settings.jsx";
import { AuthRoot } from "./auth/AuthRoot.jsx";

const NAV = [
  { id: "chat", label: "消息", icon: MessageCircle },
  { id: "contacts", label: "通讯录", icon: Users },
  { id: "agents", label: "Agent", icon: Bot },
];

function Rail() {
  const { state, dispatch } = useStore();
  const unread = unreadTotal(state);
  const go = (section) => dispatch({ type: "nav", patch: { section, pane: section === "settings" ? "main" : "list" } });
  return (
    <nav className="rail" aria-label="主导航">
      <BrandMark size={38} />
      <button type="button" className="rail-me" onClick={() => go("settings")} aria-label="我的资料与设置">
        <Avatar id={ME} size={48} online />
      </button>
      <div className="rail-nav">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={`rail-item ${state.nav.section === id ? "active" : ""}`} aria-current={state.nav.section === id ? "page" : undefined} onClick={() => go(id)}>
            <span className="rail-icon">
              <Icon size={26} aria-hidden="true" />
              {id === "chat" && unread > 0 && <span className="badge">{unread}</span>}
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button type="button" className={`rail-item ${state.nav.section === "settings" ? "active" : ""}`} onClick={() => go("settings")}>
          <span className="rail-icon">
            <Settings size={26} aria-hidden="true" />
          </span>
          <span>设置</span>
        </button>
      </div>
    </nav>
  );
}

/**
 * The open conversation disappeared while loaded (I left or was removed: `gone`, or missing from a sync):
 * close it, so nothing of it stays on screen, and say why once.
 */
function useCloseWhenRemoved(state, dispatch) {
  const { convId, section } = state.nav;
  const present = Boolean(convId && state.convs[convId]);
  const shown = useRef(null);
  useEffect(() => {
    if (present) {
      shown.current = convId;
      return;
    }
    if (!convId || convId !== shown.current || !state.loaded) return;
    shown.current = null;
    dispatch({ type: "nav", patch: { convId: null, view: "chat", detailsOpen: false } });
    if (section === "chat") dispatch({ type: "toast", text: "你已不在该会话中" });
  }, [convId, present, section, state.loaded, dispatch]);
}

/** How long a conversation I asked for (a new group, a friend's chat) may take to arrive before I stop waiting. */
export const OPENING_WAIT_MS = 8000;

/**
 * `nav.opening` ({convId} or {peerId}) names a conversation the screen wants to show as soon as it is in state
 * (created or accepted a moment ago). It opens it, or gives up after OPENING_WAIT_MS.
 */
function useOpenWhenPresent(state, dispatch) {
  const { opening } = state.nav;
  const target = opening
    ? opening.convId
      ? state.convs[opening.convId]
      : Object.values(state.convs).find((c) => c.type === "human" && c.peerId === opening.peerId)
    : null;
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!opening || !targetId) return;
    dispatch({ type: "nav/openConv", convId: targetId, patch: { opening: null } });
  }, [opening, targetId, dispatch]);
  useEffect(() => {
    if (!opening) return undefined;
    const handle = window.setTimeout(() => {
      dispatch({ type: "nav", patch: { opening: null } });
      dispatch({ type: "toast", text: "会话还没有同步下来，请稍后在消息列表里查看" });
    }, OPENING_WAIT_MS);
    return () => window.clearTimeout(handle);
  }, [opening, dispatch]);
}

function Shell() {
  const { state, dispatch } = useStore();
  useCloseWhenRemoved(state, dispatch);
  useOpenWhenPresent(state, dispatch);
  const { nav } = state;
  const conv = state.convs[nav.convId];
  let list = null;
  let main = null;
  let side = null;

  if (nav.section === "chat") {
    list = <ChatList />;
    if (!conv) main = <div className="empty-main">选择一个会话开始聊天</div>;
    else if (nav.view === "profile") main = <GroupProfile conv={conv} />;
    else {
      main = <ChatView conv={conv} />;
      if (nav.detailsOpen) side = <DetailsPanel conv={conv} />;
    }
  } else if (nav.section === "contacts") {
    list = <ContactsList />;
    main = <ContactCard />;
  } else if (nav.section === "agents") {
    list = <AgentsList />;
    main = <AgentMain />;
  } else {
    list = <SettingsList />;
    main = <SettingsMain />;
  }

  return (
    <div className="app" data-pane={nav.pane} data-side={side ? "open" : "closed"}>
      <Rail />
      <aside className="list-col">{list}</aside>
      <main className="main-col">{main}</main>
      {side && <aside className="side-col">{side}</aside>}
      {state.toast && (
        <div className="toast" role="status" aria-live="polite">
          {state.toast.text}
        </div>
      )}
    </div>
  );
}

export function App(props) {
  return (
    <AuthRoot {...props}>
      {(dataLayer, key) => (
        <StoreProvider key={key} dataLayer={dataLayer}>
          <Shell />
        </StoreProvider>
      )}
    </AuthRoot>
  );
}
