import React from "react";
import { StoreProvider, useStore } from "./state/store.jsx";
import { unreadTotal } from "./state/selectors.js";
import { ME } from "./data/identities.js";
import { Avatar, BrandMark } from "./ui/primitives.jsx";
import { MessageCircle, Users, Bot, Settings, FlaskConical } from "./icons.js";
import { ChatList } from "./pages/ChatList.jsx";
import { ChatView } from "./pages/ChatView.jsx";
import { GroupProfile } from "./pages/GroupProfile.jsx";
import { DetailsPanel } from "./pages/DetailsPanel.jsx";
import { TaskPanel } from "./pages/TaskPanel.jsx";
import { ContactsList, ContactCard } from "./pages/Contacts.jsx";
import { AgentsList, AgentMain } from "./pages/Agents.jsx";
import { SettingsList, SettingsMain } from "./pages/Settings.jsx";
import { DemoDrawer } from "./pages/DemoDrawer.jsx";
import { LiveGate } from "./live/LiveStore.jsx";

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
        <button type="button" aria-label="演示状态" className={`rail-item rail-demo ${state.nav.demoOpen ? "active" : ""}`} onClick={() => dispatch({ type: "nav", patch: { demoOpen: !state.nav.demoOpen } })}>
          <span className="rail-icon">
            <FlaskConical size={22} aria-hidden="true" />
          </span>
          <span>演示状态</span>
        </button>
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

function Shell() {
  const { state } = useStore();
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
      if (nav.taskOpen) side = <TaskPanel conv={conv} />;
      else if (nav.detailsOpen) side = <DetailsPanel conv={conv} />;
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
      {nav.demoOpen && <DemoDrawer />}
      {state.toast && (
        <div className="toast" role="status" aria-live="polite">
          {state.toast.text}
        </div>
      )}
    </div>
  );
}

export function App() {
  // Spike: ?live=<server base url> swaps the mock store for a live backend session.
  const params = new URLSearchParams(window.location.search);
  const live = params.get("live");
  const core = params.get("core");
  if (live) return <LiveGate baseUrl={live}><Shell /></LiveGate>;
  if (core) return <LiveGate baseUrl={core} backend="core"><Shell /></LiveGate>;
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
