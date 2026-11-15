import React from "react";
import { ListHeader } from "./ChatList.jsx";

// Agents are not available yet.
export function AgentsList() {
  return (
    <>
      <ListHeader title="Agent" />
      <p className="list-note">尚未开放</p>
    </>
  );
}

export function AgentMain() {
  return <div className="empty-main">尚未开放</div>;
}
