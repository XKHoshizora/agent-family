import React from "react";
import { ListHeader } from "./ChatList.jsx";

// Agents are not available yet.
export function AgentsList() {
  return (
    <>
      <ListHeader title="Agent" />
      <ul className="rows">
        <li className="rows-empty">尚未开放</li>
      </ul>
    </>
  );
}

export function AgentMain() {
  return <div className="empty-main">尚未开放</div>;
}
