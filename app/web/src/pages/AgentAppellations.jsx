import React, { useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { appellation as appellationProblem } from "../auth/validation.js";
import { entity } from "../state/selectors.js";
import { friendIds } from "../state/social.js";
import { Btn, Tag, composing } from "../ui/primitives.jsx";
import { refusalText, settled, useAction } from "./useAction.js";

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

/**
 * The writes of one row, one at a time (`useAction`, which does not toast here): `pending` says one is running, `error` is
 * the sentence of the last refusal, shown under the row. `valid` says whether a typed appellation is one (and shows why not).
 */
function useWrite() {
  const { busy, run } = useAction();
  const [error, setError] = useState("");
  const valid = (typed) => {
    const problem = appellationProblem(typed);
    setError(problem);
    return !problem;
  };
  /** Runs `call` (an action); true when the service took it. A refusal is kept for the row; a success needs nothing (the row is replaced). */
  const write = async (call) => {
    setError("");
    const res = await run("write", () => settled(call()), () => "");
    if (!res.ok && res.error?.code !== "busy_here") setError(refusalText(res.error));
    return res.ok;
  };
  return { pending: busy !== null, error, valid, write };
}

/** Enter saves a row (`save`), never the Agent's form it sits in; Enter that confirms an input method's candidate is not Enter. */
const enterSaves = (save) => (event) => {
  if (event.key !== "Enter" || composing(event)) return;
  event.preventDefault();
  save();
};

/**
 * What a row says in place of the name of an Agent the service no longer shows: someone else's, in no group with this
 * one now, or a deleted one.
 */
const GONE_AGENT = "已不在同一个群里的 Agent";

/** One stored appellation: the target, the appellation saved when I leave the box or press Enter, and 移除. */
function Row({ agentId, entry }) {
  const { actions } = useStore();
  const { pending, error, valid, write } = useWrite();
  const [text, setText] = useState(entry.appellation);
  const removeButton = useRef(null);
  const name = entry.name ?? GONE_AGENT;
  const label = `给${name}的称呼`;

  /** The box shows what is stored again: an edit that is not sent is dropped where it is seen. */
  const revert = () => setText(entry.appellation);
  const commit = async () => {
    const typed = text.trim();
    // Nothing to say is not an appellation: the row goes back to what is stored (移除 is how one goes).
    if (typed === "" || typed === entry.appellation) return revert();
    if (valid(typed)) await write(() => actions.setAppellation(agentId, entry.principalId, typed));
  };
  // Leaving the box for 移除 (by Tab, too) drops the edit: only the removal is sent.
  const blur = (event) => (event.relatedTarget === removeButton.current ? revert() : commit());

  return (
    <li>
      <div className="member-body">
        <span>
          <strong>{name}</strong> {entry.kind === "agent" && <Tag>Agent</Tag>} {entry.handle !== null && <small>@{entry.handle}</small>}
        </span>
        <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={blur} onKeyDown={enterSaves(commit)} readOnly={pending} autoComplete="off" />
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      <div className="member-actions">
        <Btn
          ref={removeButton}
          small
          disabled={pending}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => write(() => actions.removeAppellation(agentId, entry.principalId))}
        >
          移除
        </Btn>
      </div>
    </li>
  );
}

/** 添加称呼's row: the person to name (a picker) and the appellation, saved by its own button. */
function AddRow({ agentId, candidates, onDone }) {
  const { actions } = useStore();
  const { pending, error, valid, write } = useWrite();
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const typed = text.trim();

  const save = async () => {
    if (!target || !typed || !valid(typed)) return;
    if (await write(() => actions.setAppellation(agentId, target, typed))) onDone();
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
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={enterSaves(save)} autoComplete="off" placeholder="称呼" />
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
