// What an Agent heard others say in groups: only a lead, used only in the group it came from and in the owner's own
// conversation with the Agent. Each line is taken as true (属实: it becomes one of the Agent's own notes) or forgotten.
import React, { useRef } from "react";
import { useStore } from "../data/store.jsx";
import { formatAt } from "../data/viewmodel.js";
import { Btn } from "../ui/primitives.jsx";
import { DeleteButton, firstActionOf, neighbourOf, useNoteWrite, useRefocus, usedPercent } from "./MemoryRoom.jsx";

function HeardRow({ agentId, line, memory, leaving }) {
  const { actions } = useStore();
  const { pending, error, write } = useNoteWrite(memory);
  const textId = `memory-heard-${line.id}`;
  /** A write that takes the line out of the list: the focus goes to its neighbour once the room is read again. */
  const leave = async (call) => {
    leaving(line);
    if (!(await write(call))) leaving(null);
  };
  return (
    <li className="memory-row" data-memory-id={line.id}>
      <div className="memory-body">
        <p className="memory-text" id={textId}>{`${line.speakerName}${line.speakerHandle ? `（@${line.speakerHandle}）` : ""}说：${line.text}`}</p>
        <p className="memory-source muted">{`${formatAt(Date.parse(line.saidAt), Date.now())} · ${line.group?.title ?? "一个已离开的群"}`}</p>
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="memory-actions">
        <Btn small disabled={pending} aria-describedby={textId} onClick={() => leave(() => actions.confirmHearsay(agentId, line.id))}>属实</Btn>
        <DeleteButton disabled={pending} describedBy={textId} onDelete={() => leave(() => actions.deleteHearsay(agentId, line.id))} />
      </div>
    </li>
  );
}

/** `memory` is `useMemoryRoom(agentId)`'s answer (the Agent's memory, which carries what it heard). */
export function MemoryHearsay({ agentId, agentName, memory }) {
  const { room } = memory;
  const section = useRef(null);
  const refocus = useRefocus(room);
  const title = `${agentName}听说的`;
  const leaving = (line) => refocus(line ? firstActionOf(section, neighbourOf(room.hearsay, line)) : null);
  return (
    <section className="memory-room" aria-label={title} ref={section}>
      <header className="memory-head">
        <h3>{title}</h3>
        <span className="muted">已用 {usedPercent(room.hearsayUsed, room.hearsayLimit)}%</span>
      </header>
      <p className="muted">只当线索 · 只用在来源的群和你们的对话里</p>
      <ul className="memory-rows memory-open">
        {room.hearsay.map((line) => (
          <HeardRow key={line.id} agentId={agentId} line={line} memory={memory} leaving={leaving} />
        ))}
        {room.hearsay.length === 0 && <li className="rows-empty">还没有听说什么</li>}
      </ul>
    </section>
  );
}
