// The parts of a conversation with one of my Agents that a human chat does not have: its text (one renderer for stored
// and streaming replies), the folded thinking, the reply being written, the failed reply's status line, the persona
// proposal card, the new-topic confirmation and divider, and the image hint. Each shows what the view model says
// (`conv.run`, `conv.stream`, `msg.proposal`…); none of them derives it again from the model.
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { runFailureText } from "../data/errorTexts.js";
import { nameOf, publishBlock } from "../state/selectors.js";
import { Avatar, Btn, Field, IconBtn, Modal, Notice, Reason, Tag, focusInvalid } from "../ui/primitives.jsx";
import { refusalText, settled } from "./AgentForm.jsx";
import { useAction, useNow } from "./useAction.js";
import { RotateCw, Sparkles, Square, X } from "../icons.js";

/** The pause notice of a paused Agent (as on its detail page). */
export const AGENT_PAUSED_TEXT = "已暂停全部会话：它不会有新回复。与「停止生成」不同，这不是只中断一次回复。恢复后，暂停期间收到的消息不会补上回复。";
/** Under the composer when an image goes to an Agent whose model cannot see images. */
export const IMAGE_HINT = "当前模型看不到图片，只会知道文件名";

const PERSONA_MAX = 20000;
const INTRO_MAX = 40;
const FIELD_MAX = 20;
const chars = (text) => [...text].length;

/** Whether the Agent's model sees images: true or false, or null when that is not known here (no model, not loaded). */
export function seesImages(state, model) {
  if (!model) return null;
  if (model.source === "site") return state.siteModels.find((m) => m.id === model.id)?.vision ?? null;
  return state.providers[model.providerId]?.models.find((m) => m.name === model.model)?.vision ?? null;
}

/** Whether a reply of the conversation's Agent is being written: queued or running, its message not here yet. */
export const isReplying = (run) => Boolean(run) && (run.status === "queued" || run.status === "running") && !run.posted;

/** The text of an Agent's message, stored or streaming. Plain like a person's for now: the one place a renderer goes. */
export function AgentText({ text }) {
  return <>{text}</>;
}

/** The model's thinking: folded above the answer, opened only by the reader. */
export function Thinking({ text }) {
  if (!text) return null;
  return (
    <details className="thinking">
      <summary>思考过程</summary>
      <div className="thinking-text">{text}</div>
    </details>
  );
}

/**
 * The reply being written, at the end of the list: its text so far (or 正在回复… before the first piece, and for a reply
 * that was already under way when this page connected, whose text is not sent again), its thinking, and 停止生成.
 * Busy for assistive technology while it grows: the stored reply that replaces it is announced instead (ChatView).
 */
export function StreamBubble({ conv }) {
  const { state, dispatch, actions } = useStore();
  const run = conv.run;
  const text = conv.stream?.text ?? "";
  // The run whose stop was asked for: the button stays disabled until that run ends (a new run has its own button).
  const [stopping, setStopping] = useState(null);
  const stop = async () => {
    setStopping(run.id);
    const res = await actions.stopRun(conv.id);
    if (res.ok) return;
    // The reply ended meanwhile (nothing to stop), or it is not there any more: nothing to say.
    if (res.error?.code === "no_run" || res.error?.status === 404) return;
    setStopping(null);
    dispatch({ type: "toast", text: res.text });
  };
  return (
    <li className="msg theirs streaming" aria-busy="true">
      <Avatar id={conv.agentId} size={40} />
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{nameOf(state, conv.agentId)}</strong>
          <Tag>Agent</Tag>
        </div>
        <Thinking text={conv.stream?.reasoning} />
        <div className="bubble">
          {text ? (
            <AgentText text={text} />
          ) : (
            <>
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>{" "}
              正在回复…
            </>
          )}
        </div>
        <div className="msg-foot">
          <Btn small disabled={stopping === run.id} onClick={stop}>
            <Square size={12} aria-hidden="true" /> 停止生成
          </Btn>
        </div>
      </div>
    </li>
  );
}

/** Keeps answers that arrive after the component has gone (its run moved on) from being applied. */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * A failed reply, at the end of the list: not a message (no seq, no avatar, no time, nothing to quote or find). Its
 * sentence, 重试 when trying again may work, where to fix it (usage and balance, the Agent's edit page), and a close
 * control. A retry refused because a reply is already going says nothing (that reply shows as it comes); any other
 * refusal says why here.
 */
export function RunStatusLine({ conv, run }) {
  const { dispatch, actions } = useStore();
  const mounted = useMounted();
  // (A reset time reads 今天 / 明天 from now: kept current while the line is shown.)
  const now = useNow();
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const go = (patch) => dispatch({ type: "nav", patch: { pane: "main", ...patch } });
  const act = async (key, work, quiet = () => false) => {
    setBusy(key);
    setNote(null);
    const res = await work();
    if (!mounted.current) return;
    setBusy(null);
    if (!res.ok && !quiet(res.error)) setNote(res.text);
  };
  const retry = () => act("retry", () => actions.retryRun(conv.id), (error) => error?.code === "busy_run");
  const dismiss = () => act("dismiss", () => actions.dismissRun(conv.id));
  return (
    <li className="msg-system run-status">
      <Notice
        tone="warn"
        action={
          <span className="notice-actions">
            {run.retryable && (
              <Btn small variant="primary" disabled={busy !== null} onClick={retry}>
                <RotateCw size={13} aria-hidden="true" /> 重试
              </Btn>
            )}
            {run.error === "no_quota" && (
              <Btn small onClick={() => go({ section: "settings", settingsPage: "usage" })}>
                查看用量与余额
              </Btn>
            )}
            {run.error === "context_too_small" && (
              <Btn small onClick={() => go({ section: "agents", agentId: conv.agentId, agentView: "edit" })}>
                修改 Agent
              </Btn>
            )}
            <IconBtn label="关闭提示" disabled={busy !== null} onClick={dismiss}>
              <X size={16} />
            </IconBtn>
          </span>
        }
      >
        {runFailureText(run, now)}
        {note && <span className="notice-sub">{note}</span>}
      </Notice>
    </li>
  );
}

/** A divider where a new topic began (the `topic_reset` notice): nothing before it is sent to the Agent any more. */
export function TopicDivider({ msg }) {
  return (
    <li className="msg-divider" data-msg={msg.id} title={msg.text}>
      <span>新话题</span>
    </li>
  );
}

/** Asks before starting a new topic in the Agent's conversation. */
export function NewTopicModal({ conv, onClose }) {
  const { actions } = useStore();
  const { busy, run } = useAction();
  const confirm = async () => {
    const res = await run("topic", () => settled(actions.resetTopic(conv.id)), refusalText);
    if (res.ok) onClose();
  };
  return (
    <Modal
      title="开始新话题"
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>
            取消
          </Btn>
          <Btn variant="primary" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "开始新话题"}
          </Btn>
        </>
      }
    >
      <p>之前的对话不会再发给它，聊天记录仍然保留。</p>
    </Modal>
  );
}

/** A proposal's state: the tag on its card. */
const PROPOSAL_STATUS = {
  open: ["待你确认", "pending"],
  confirmed: ["已采用", "ok"],
  discarded: ["已放弃", "muted"],
  superseded: ["已被新的提议取代", "muted"],
  stale: ["已失效", "warn"],
};
const FOLD_LINES = 5;
const FOLD_CHARS = 240;

/** The first lines of a long persona (null when it is short enough to show whole). */
function foldedText(text) {
  let head = text.split("\n").slice(0, FOLD_LINES).join("\n");
  if (chars(head) > FOLD_CHARS) head = [...head].slice(0, FOLD_CHARS).join("");
  return head === text ? null : `${head}…`;
}

/** The proposal opened in an editor: confirmed with the edited persona (and the 简介 / 擅长领域 it proposes). */
function ProposalEditor({ proposal, onClose, onConfirm }) {
  const mounted = useMounted();
  const hasIntro = typeof proposal.intro === "string";
  const hasField = typeof proposal.field === "string";
  const [persona, setPersona] = useState(proposal.persona ?? "");
  const [intro, setIntro] = useState(proposal.intro ?? "");
  const [field, setField] = useState(proposal.field ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const body = persona.replace(/\0/g, "").trim();
  const errors = {
    persona: !body ? "人格文档不能为空" : chars(body) > PERSONA_MAX ? `人格文档不超过 ${PERSONA_MAX} 个字` : "",
    intro: chars(intro.trim()) > INTRO_MAX ? `简介不超过 ${INTRO_MAX} 个字` : "",
    field: chars(field.trim()) > FIELD_MAX ? `擅长领域不超过 ${FIELD_MAX} 个字` : "",
  };
  const shown = (key) => (tried ? errors[key] : "");
  const submit = async () => {
    setTried(true);
    if (errors.persona || errors.intro || errors.field) {
      focusInvalid();
      return;
    }
    const edits = { persona: body };
    if (hasIntro) edits.intro = intro.trim();
    if (hasField) edits.field = field.trim();
    setBusy(true);
    setRefusal(null);
    const res = await onConfirm(edits);
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok) onClose();
    else setRefusal(res.text);
  };
  return (
    <Modal
      title="修改后确认"
      wide
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit}>
            {busy ? "处理中…" : "确认"}
          </Btn>
        </>
      }
    >
      <Field label="人格文档" hint={`${chars(persona)} / ${PERSONA_MAX}`} error={shown("persona")}>
        <textarea data-autofocus rows={10} value={persona} onChange={(e) => setPersona(e.target.value)} />
      </Field>
      {hasIntro && (
        <Field label="简介" error={shown("intro")}>
          <input value={intro} onChange={(e) => setIntro(e.target.value)} />
        </Field>
      )}
      {hasField && (
        <Field label="擅长领域" error={shown("field")}>
          <input value={field} onChange={(e) => setField(e.target.value)} />
        </Field>
      )}
      <Reason>确认后，它从下一次回复起按新的人格文档回复。人格文档只影响它如何回复，不授予任何权限。</Reason>
      {refusal && (
        <p className="field-msg" role="alert">
          {refusal}
        </p>
      )}
    </Modal>
  );
}

/**
 * The persona an Agent proposes in a reply (`msg.proposal`): the persona (folded beyond a few lines), the 简介 and
 * 擅长领域 it names, and by its state 确认 / 修改后确认 / 放弃 or what became of it. A refusal (the proposal went stale or
 * was superseded meanwhile) fetches the card again (the actions do), and its sentence stays on the card until the card
 * shows its real state.
 */
export function ProposalCard({ msg, conv }) {
  const { state, actions } = useStore();
  const mounted = useMounted();
  const p = msg.proposal;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const persona = p.persona ?? "";
  const folded = foldedText(persona);
  const open = p.status === "open";
  // A deleted Agent's proposals can no longer be decided (an open one is then only "not confirmed").
  const decidable = open && !publishBlock(state, conv);
  const [label, tone] = open && !decidable ? ["未确认", "muted"] : PROPOSAL_STATUS[p.status] ?? [p.status, "muted"];
  const decide = async (key, pending) => {
    setBusy(key);
    setRefusal(null);
    const res = await pending;
    if (!mounted.current) return res;
    setBusy(null);
    if (!res.ok) setRefusal(res.text);
    return res;
  };
  const confirm = () => decide("confirm", actions.confirmProposal(conv.agentId, p.id));
  const discard = () => decide("discard", actions.discardProposal(conv.agentId, p.id));
  // (The editor says its own refusal; a card that went stale or was superseded meanwhile closes it.)
  const confirmEdited = (edits) => actions.confirmProposal(conv.agentId, p.id, edits);
  return (
    <div className="card proposal-card">
      <div className="card-head">
        <Sparkles size={18} aria-hidden="true" />
        <strong>配置提议</strong>
        <Tag tone={tone}>{label}</Tag>
      </div>
      <dl className="mini-kv">
        {p.intro && (
          <div>
            <dt>简介</dt>
            <dd>{p.intro}</dd>
          </div>
        )}
        {p.field && (
          <div>
            <dt>擅长领域</dt>
            <dd>{p.field}</dd>
          </div>
        )}
        <div>
          <dt>人格文档</dt>
          <dd className="proposal-persona">{folded === null || expanded ? persona : folded}</dd>
        </div>
      </dl>
      {folded !== null && (
        <Btn small variant="text" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "展开全部"}
        </Btn>
      )}
      {p.status === "stale" && <Reason>配置已变更，请重新生成提议</Reason>}
      {decidable && (
        <div className="card-actions">
          <Btn variant="primary" disabled={busy !== null} onClick={confirm}>
            {busy === "confirm" ? "处理中…" : "确认"}
          </Btn>
          <Btn disabled={busy !== null} onClick={() => setEditing(true)}>
            修改后确认
          </Btn>
          <Btn variant="text" disabled={busy !== null} onClick={discard}>
            {busy === "discard" ? "处理中…" : "放弃"}
          </Btn>
        </div>
      )}
      {open && refusal && (
        <p className="field-msg" role="alert">
          {refusal}
        </p>
      )}
      {editing && decidable && <ProposalEditor proposal={p} onClose={() => setEditing(false)} onConfirm={confirmEdited} />}
    </div>
  );
}
