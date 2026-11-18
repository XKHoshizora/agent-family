import React, { useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { appellation as appellationProblem } from "../auth/validation.js";
import { entity } from "../state/selectors.js";
import { friendIds } from "../state/social.js";
import { Btn, Tag } from "../ui/primitives.jsx";

/**
 * Whom the owner may still name for this Agent, composed from what the app holds: my friends and the members (people
 * and Agents) of the groups the Agent is in now, less the Agent itself, me and those already listed; by name.
 */
function candidatesFor(state, agent, entries) {
  const listed = new Set(entries.map((e) => e.principalId));
  const ids = new Set(friendIds(state));
  for (const conv of Object.values(state.convs)) {
    if (conv.type === "group" && conv.members.includes(agent.id)) for (const id of conv.members) ids.add(id);
  }
  ids.delete(agent.id);
  ids.delete(ME);
  return [...ids]
    .filter((id) => !listed.has(id))
    .map((id) => entity(state, id))
    .filter(Boolean)
    .map((e) => ({ principalId: e.id, kind: e.kind, name: e.name, handle: e.handle.replace(/^@/, "") }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh") || (a.principalId < b.principalId ? -1 : 1));
}

/** Runs one write of a row: `pending` says it is running; its refusal's sentence is kept in `error` (cleared on success). */
function useWrite() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const write = async (call) => {
    if (running.current) return null;
    running.current = true;
    setPending(true);
    const res = await call();
    running.current = false;
    setPending(false);
    setError(res.ok ? "" : res.text);
    return res;
  };
  return { pending, error, setError, write };
}

/** One stored appellation: the target, the appellation saved when I leave the box or press Enter, and 移除. */
function Row({ agentId, entry }) {
  const { actions } = useStore();
  const { pending, error, setError, write } = useWrite();
  const [text, setText] = useState(entry.appellation);
  const label = `给${entry.name}的称呼`;

  const commit = async () => {
    const typed = text.trim();
    // Nothing to say is not an appellation: the row goes back to what is stored (移除 is how one goes).
    if (typed === "" || typed === entry.appellation) {
      setText(entry.appellation);
      return;
    }
    const problem = appellationProblem(typed);
    if (problem) {
      setError(problem);
      return;
    }
    await write(() => actions.setAppellation(agentId, entry.principalId, typed));
  };
  const onKeyDown = (event) => {
    if (event.key !== "Enter") return;
    // (The row is inside the Agent's form: Enter here saves the row, never the form.)
    event.preventDefault();
    commit();
  };

  return (
    <li>
      <div className="member-body">
        <span>
          <strong>{entry.name}</strong> {entry.kind === "agent" && <Tag>Agent</Tag>} <small>@{entry.handle}</small>
        </span>
        <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} readOnly={pending} autoComplete="off" />
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="member-actions">
        <Btn small disabled={pending} onClick={() => write(() => actions.removeAppellation(agentId, entry.principalId))}>移除</Btn>
      </div>
    </li>
  );
}

/** 添加称呼's row: the person to name (a picker) and the appellation, saved by its own button. */
function AddRow({ agentId, candidates, onDone }) {
  const { actions } = useStore();
  const { pending, error, setError, write } = useWrite();
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const typed = text.trim();

  const save = async () => {
    const problem = appellationProblem(typed);
    if (problem) {
      setError(problem);
      return;
    }
    const res = await write(() => actions.setAppellation(agentId, target, typed));
    if (res?.ok) onDone();
  };

  return (
    <li>
      <div className="member-body">
        <select aria-label="选择好友或群成员" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">选择好友或群成员</option>
          {candidates.map((c) => (
            <option key={c.principalId} value={c.principalId}>
              {`${c.name} @${c.handle}${c.kind === "agent" ? " · Agent" : ""}`}
            </option>
          ))}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="称呼" />
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="member-actions">
        <Btn small variant="primary" disabled={pending || !target || !typed} onClick={save}>保存称呼</Btn>
        <Btn small disabled={pending} onClick={onDone}>取消</Btn>
      </div>
    </li>
  );
}

/**
 * 它怎么称呼别人 of the Agent's edit form: what it calls others, as the service holds it (the owner's view of the
 * Agent). Its rows save at once on their own, not with the form's 保存; the list is whatever the service last answered.
 */
export function AgentAppellations({ agent }) {
  const { state } = useStore();
  const [adding, setAdding] = useState(false);
  const entries = agent.appellations ?? [];
  return (
    <div className="field">
      <span className="field-label">它怎么称呼别人</span>
      <ul className="member-rows appellation-rows">
        {entries.map((entry) => (
          <Row key={`${entry.principalId}:${entry.appellation}`} agentId={agent.id} entry={entry} />
        ))}
        {entries.length === 0 && !adding && <li className="rows-empty">还没有给别人设称呼。</li>}
        {adding && <AddRow agentId={agent.id} candidates={candidatesFor(state, agent, entries)} onDone={() => setAdding(false)} />}
      </ul>
      {!adding && (
        <div className="member-actions">
          <Btn small onClick={() => setAdding(true)}>添加称呼</Btn>
        </div>
      )}
    </div>
  );
}
