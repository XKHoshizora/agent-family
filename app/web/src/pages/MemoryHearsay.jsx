// What an Agent heard others say in groups: only a lead, used only in the group it came from and in the owner's own
// conversation with the Agent. Each line is taken as true (属实: it becomes one of the Agent's own notes) or forgotten.
import React from "react";
import { useStore } from "../data/store.jsx";
import { formatAt } from "../data/viewmodel.js";
import { Btn } from "../ui/primitives.jsx";
import { usedPercent, useRowWrite } from "./MemoryRoom.jsx";

function HeardRow({ agentId, line, reload }) {
  const { actions } = useStore();
  const { pending, error, write } = useRowWrite(reload);
  return (
    <li className="memory-row">
      <div className="memory-body">
        <p className="memory-text">{`${line.speakerName}说：${line.text}`}</p>
        <p className="memory-source muted">{`${formatAt(Date.parse(line.saidAt), Date.now())} · ${line.group?.title ?? "已离开的群"}`}</p>
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="memory-actions">
        <Btn small disabled={pending} onClick={() => write(() => actions.confirmHearsay(agentId, line.id))}>属实</Btn>
        <Btn small disabled={pending} onClick={() => write(() => actions.deleteHearsay(agentId, line.id))}>删除</Btn>
      </div>
    </li>
  );
}

/** `room` and `reload` come from `useMemoryRoom(agentId)` (the answer of the Agent's memory, which carries what it heard). */
export function MemoryHearsay({ agentId, agentName, room, reload }) {
  const title = `${agentName}听说的`;
  return (
    <section className="memory-room" aria-label={title}>
      <header className="memory-head">
        <h3>{title}</h3>
        <span className="muted">已用 {usedPercent(room.hearsayUsed, room.hearsayLimit)}%</span>
      </header>
      <p className="muted">只当线索 · 只用在来源的群和你们的对话里</p>
      <ul className="memory-rows memory-open">
        {room.hearsay.map((line) => (
          <HeardRow key={line.id} agentId={agentId} line={line} reload={reload} />
        ))}
        {room.hearsay.length === 0 && <li className="rows-empty">还没有听说什么。</li>}
      </ul>
    </section>
  );
}
