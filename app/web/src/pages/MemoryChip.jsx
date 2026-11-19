// What the owner is told when their Agent remembered something (the `memory_changed` notice, only ever in their own
// conversation with that Agent): a small closed chip (one sentence with the Agent's name, `memorySentence`) that opens to the lines of the change with 撤销; and the
// two confirmation cards (记住 / 不用 for new notes, 取出 / 不用 for a note to take out of the vault). Following
// TopicDivider (a notice) and ProposalCard (decisions, one at a time, a refusal said on the card).
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ChevronDown, Lock } from "../icons.js";
import { memorySentence } from "../data/memoryPhrases.js";
import { entity, publishBlock } from "../state/selectors.js";
import { Btn, Tag } from "../ui/primitives.jsx";
import { useDecision } from "./AgentChatBits.jsx";

/** The lines of a change, each with the vault tag when it went into (or came out of) the vault. */
function MemoryLines({ system }) {
  return (
    <ul className="memory-lines">
      {system.lines.map((line, i) => (
        <li key={i}>
          {line}
          {system.vaultLines[i] && <Tag tone="muted">保险箱</Tag>}
        </li>
      ))}
    </ul>
  );
}

/**
 * One notice of a change to my Agent's memory, by its state: applied → the chip (closed; opened: the lines, 撤销 or 已撤销,
 * and — when the room is nearly full — a link to the palace's settings); pending → the card asking first; discarded → nothing.
 * A refusal (the change went stale meanwhile) stays on it as a sentence.
 */
export function MemoryNotice({ msg, conv }) {
  const { state, actions, dispatch } = useStore();
  const { mounted, busy, refusal, decide } = useDecision();
  const system = msg.system;
  const [open, setOpen] = useState(false);
  // Refused as stale (the memory changed since): the notice keeps its lines and offers nothing more.
  const [stale, setStale] = useState(false);
  // A deleted Agent's changes can no longer be decided, as its proposals cannot.
  const decidable = !stale && !publishBlock(state, conv);

  const run = async (key, request) => {
    const res = await decide(key, request);
    if (mounted.current && !res.ok && res.error?.code === "stale_change") setStale(true);
  };
  const undo = () => run("undo", actions.undoMemoryChange(conv.agentId, system.changeId));
  const confirm = () => run("confirm", actions.confirmMemoryChange(conv.agentId, system.changeId));
  const discard = () => run("discard", actions.discardMemoryChange(conv.agentId, system.changeId));
  const openPalace = () => dispatch({ type: "nav", patch: { pane: "main", section: "settings", settingsPage: "memory" } });

  const alert = refusal && (
    <p className="field-msg" role="alert">
      {refusal}
    </p>
  );

  if (system.status === "discarded") return <li className="msg-memory" data-msg={msg.id} hidden />;

  if (system.status === "pending") {
    const title = system.unlock ? "要把这条从保险箱取出来吗？" : "要记住这些吗？";
    const yes = system.unlock ? "取出" : "记住";
    return (
      <li className="msg-memory" data-msg={msg.id}>
        <div className="card memory-card">
          <div className="card-head">
            {system.unlock && <Lock size={16} aria-hidden="true" />}
            <strong>{title}</strong>
          </div>
          <MemoryLines system={system} />
          {!stale && (
            <div className="card-actions">
              <Btn variant="primary" disabled={!decidable || busy !== null} onClick={confirm}>
                {busy === "confirm" ? "处理中…" : yes}
              </Btn>
              <Btn variant="text" disabled={!decidable || busy !== null} onClick={discard}>
                {busy === "discard" ? "处理中…" : "不用"}
              </Btn>
            </div>
          )}
          {alert}
        </div>
      </li>
    );
  }

  // The Agent's name as the conversation shows it; one that cannot be named is 它.
  const sentence = memorySentence({ ...system, name: entity(state, system.actorId)?.name || "它" });
  return (
    <li className="msg-memory" data-msg={msg.id}>
      <button type="button" className="memory-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        {sentence}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="memory-detail">
          <MemoryLines system={system} />
          <div className="memory-foot">
            {system.status === "undone" ? (
              <span className="muted">已撤销</span>
            ) : (
              !stale && (
                <Btn small variant="text" disabled={!decidable || busy !== null} onClick={undo}>
                  {busy === "undo" ? "处理中…" : "撤销"}
                </Btn>
              )
            )}
          </div>
          {system.full && (
            <p className="memory-hint">
              <Btn small variant="text" onClick={openPalace}>
                记忆宫殿快满了，去整理一下。
              </Btn>
            </p>
          )}
          {alert}
        </div>
      )}
    </li>
  );
}
