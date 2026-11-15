import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import {
  publishBlock,
  canManage,
  recoveryState,
  remainingRounds,
  supportsDiscussion,
  humansIn,
  viewerOwners,
  agentsIn,
  ownerOf,
  nameOf,
} from "../state/selectors.js";
import { Avatar, Btn, Notice, Modal, Field, Tag, Reason, IdentityLine, focusInvalid } from "../ui/primitives.jsx";

const APPROVAL = { pending: ["待确认", "pending"], approved: ["已确认", "ok"], rejected: ["已拒绝", "warn"] };

// Why this person has to confirm, so one person with several roles confirms once.
function rolesOf(state, conv, id) {
  const roles = [];
  if (humansIn(state, conv).includes(id)) roles.push("发言成员");
  const owned = agentsIn(state, conv).filter((a) => ownerOf(state, a) === id);
  if (owned.length) roles.push(`${owned.map((a) => nameOf(state, a)).join("、")}的主人`);
  return roles.join(" · ") || "可见人";
}

function ApproverList({ conv, approvals }) {
  const { state } = useStore();
  const { required } = recoveryState(state, conv);
  return (
    <ul className="approvals">
      {required.map((id) => {
        const v = approvals ? approvals[id] || "pending" : id === ME ? "approved" : "pending";
        return (
          <li key={id}>
            <Avatar id={id} size={36} />
            <span>
              <strong>{nameOf(state, id)}</strong>
              <small>{rolesOf(state, conv, id)}</small>
            </span>
            <Tag tone={APPROVAL[v][1]}>{approvals ? APPROVAL[v][0] : id === ME ? "提交即确认" : "需其本人确认"}</Tag>
          </li>
        );
      })}
    </ul>
  );
}

function RecoveryModal({ conv, onClose }) {
  const { state, dispatch } = useStore();
  const d = conv.discussion;
  const max = supportsDiscussion(conv) ? remainingRounds(conv) : 0;
  const { required } = recoveryState(state, conv);
  const others = required.filter((id) => id !== ME);
  const [summary, setSummary] = useState("");
  const [goal, setGoal] = useState(max ? d.goal : "");
  const [rounds, setRounds] = useState(max);
  const [touched, setTouched] = useState(false);
  const errSummary = touched && !summary.trim() ? "请填写恢复后可使用的新摘要" : "";
  const errGoal = touched && rounds > 0 && !goal.trim() ? "继续讨论需要填写目标" : "";
  const submit = () => {
    setTouched(true);
    if (!summary.trim() || (rounds > 0 && !goal.trim())) { focusInvalid(); return; }
    dispatch({ type: "recover/propose", convId: conv.id, summary: summary.trim(), goal: goal.trim(), rounds });
    onClose();
  };
  return (
    <Modal
      title="发起恢复确认"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" onClick={submit}>{others.length ? "提交并等待其他人确认" : "提交并确认方案"}</Btn>
        </>
      }
    >
      <p className="muted">
        本会话不会一键恢复。请写明恢复后使用的内容，由当前名单（成员版本 v{conv.version}）中每一位必需的人各自确认同一份方案。
      </p>
      <Field label="新摘要 / 输入范围" hint="恢复后讨论与回复只能使用这里写明的内容；不会自动带入旧附件、其他私聊或电脑内容，也不会向新成员转发旧历史。" error={errSummary}>
        <textarea data-autofocus rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={160} placeholder="例如：仅使用冻结后重新发布的行程要点" />
      </Field>
      {max > 0 ? (
        <>
          <Field label="剩余轮次" hint={`原方案还剩 ${max} 轮（含未完成的本轮）。只能保留或减少；增加轮次需重新设置讨论。选择 0 表示结束原讨论。`}>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
              {Array.from({ length: max + 1 }, (_, n) => (
                <option key={n} value={n}>{n === 0 ? "0 轮（结束原讨论）" : `${n} 轮`}</option>
              ))}
            </select>
          </Field>
          {rounds > 0 && (
            <Field label="讨论目标" error={errGoal}>
              <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={60} />
            </Field>
          )}
        </>
      ) : (
        supportsDiscussion(conv) && <Reason>没有进行中的讨论可继续；尚未开始的讨论方案在恢复后需重新设置并确认。</Reason>
      )}
      <div className="field">
        <span className="field-label">需要确认的人（每人一次）</span>
        <ApproverList conv={conv} />
      </div>
      <Notice tone="info">
        可见主人：{viewerOwners(state, conv).map((id) => nameOf(state, id)).join("、") || "无"}。
        {others.length
          ? "你不能代替其他人确认；成员名单再次变化或出现新的冻结原因时，已有确认全部失效。"
          : "你是唯一需要确认的人，只需确认一次；之后仍需手动完成恢复。"}
        恢复只影响本会话与本讨论，不恢复好友关系、电脑许可或旧任务。
      </Notice>
    </Modal>
  );
}

// The one freeze banner used everywhere a conversation can be restored.
export function FreezeNotice({ conv, extra, compact }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const block = publishBlock(state, conv);
  if (!block) return null;
  const manage = canManage(state, conv);
  const r = recoveryState(state, conv);
  const rec = r.rec;
  const last = rec && !r.active ? { rejected: "已被拒绝", withdrawn: "已撤回", expired: "已过期", invalid: "因名单或冻结原因变化已失效" }[rec.status] : null;
  return (
    <>
      <Notice
        tone="pause"
        action={
          <span className="notice-actions">
            {extra}
            {block.canRestore && !r.active && (
              <Btn small variant="primary" disabled={!manage} reason="只有群管理员可以发起恢复" onClick={() => setOpen(true)}>发起恢复确认</Btn>
            )}
            {r.active && (
              <>
                <Btn
                  small
                  variant="primary"
                  disabled={!r.ready || !manage}
                  reason={!manage ? "只有群管理员可以恢复" : block.pending[0] || (r.waiting.length ? `等待${r.waiting.map((id) => nameOf(state, id)).join("、")}确认` : "恢复确认已失效，请重新发起")}
                  onClick={() => dispatch({ type: "conv/restore", convId: conv.id })}
                >
                  完成恢复
                </Btn>
                {rec.initiator === ME && <Btn small onClick={() => dispatch({ type: "recover/withdraw", convId: conv.id })}>撤回方案</Btn>}
              </>
            )}
          </span>
        }
      >
        <strong>{block.text}</strong>
        {block.pending.length > 0 && <span className="notice-sub">待处理：{block.pending.join("；")}</span>}
        {block.canRestore && !r.active && (
          <span className="notice-sub">
            {last ? `恢复方案 v${rec.version} ${last}。` : ""}恢复需要当前所有必需的人确认新的摘要、目标与剩余轮次：{r.required.map((id) => nameOf(state, id)).join("、")}。
          </span>
        )}
        {r.active && (
          <span className="notice-sub">
            恢复方案 v{rec.version}（成员版本 v{rec.memberVersion}）· 新摘要「{rec.summary}」
            {rec.rounds > 0 ? ` · 目标「${rec.goal}」· 剩余 ${rec.rounds} 轮` : " · 不继续原讨论"} ·{" "}
            {!r.current
              ? "名单已变化，确认已失效"
              : r.waiting.length
                ? `等待${r.waiting.map((id) => nameOf(state, id)).join("、")}确认`
                : "所有必需的人已确认，可手动完成恢复"}
          </span>
        )}
        {r.active && !compact && <ApproverList conv={conv} approvals={rec.approvals} />}
      </Notice>
      {open && <RecoveryModal conv={conv} onClose={() => setOpen(false)} />}
    </>
  );
}
