import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { SUMMARY_LINES } from "../data/copy.js";
import {
  convTitle,
  convSubtitle,
  visibilityNote,
  publishBlock,
  canManage,
  agentsIn,
  myAgentsIn,
  viewerOwners,
  audience,
  nameOf,
  activeTaskFor,
  isTaskOpen,
  taskPhase,
  supportsDiscussion,
  isInterject,
  canShareInto,
  isOwnPrivate,
  humansIn,
  DISCUSSION_BUDGETS,
  TURN_COST,
} from "../state/selectors.js";
import { ConvAvatar, Avatar, Btn, IconBtn, Notice, Modal, Field, Tag, Reason, IdentityLine, focusInvalid } from "../ui/primitives.jsx";
import { MessageItem } from "./Messages.jsx";
import { FreezeNotice } from "./Recovery.jsx";
import { Search, Menu, Eye, Smile, Image, Paperclip, AtSign, Square, RotateCw, ChevronLeft, X, Info, Monitor, Share2, Pause, Play, ChevronDown } from "../icons.js";

import { Composer } from "./Composer.jsx";

function DiscussionModal({ conv, onClose }) {
  const { state, dispatch } = useStore();
  const agents = agentsIn(state, conv);
  const [goal, setGoal] = useState(conv.discussion?.goal || "");
  const [input, setInput] = useState(conv.discussion?.input || "仅使用本会话中已发布的内容");
  const [rounds, setRounds] = useState(Math.min(conv.discussion?.rounds || 3, 4));
  const [budget, setBudget] = useState(DISCUSSION_BUDGETS.includes(conv.discussion?.budget) ? conv.discussion.budget : DISCUSSION_BUDGETS[1]);
  const [order, setOrder] = useState(agents);
  const need = rounds * agents.length * TURN_COST;
  const [touched, setTouched] = useState(false);
  const owners = viewerOwners(state, conv);
  const others = owners.filter((id) => id !== ME);
  const paused = agents.find((id) => state.agents[id].paused);
  const errGoal = touched && !goal.trim() ? "请填写讨论目标" : "";
  const errInput = touched && !input.trim() ? "请说明可使用的输入范围" : "";
  const moveUp = (i) => {
    if (i === 0) return;
    const next = [...order];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    setOrder(next);
  };
  const submit = () => {
    setTouched(true);
    if (!goal.trim() || !input.trim()) { focusInvalid(); return; }
    dispatch({ type: "disc/propose", convId: conv.id, goal: goal.trim(), input: input.trim(), rounds, budget, order });
    onClose();
  };
  return (
    <Modal
      title="设置讨论"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" onClick={submit}>{others.length ? "提交并等待其他主人确认" : "确认讨论方案"}</Btn>
        </>
      }
    >
      <Field label="讨论目标" error={errGoal}>
        <input data-autofocus value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={60} placeholder="例如：对齐镰仓一日游的交通安排" />
      </Field>
      <Field label="输入范围" hint="不会自动带入其他私聊、文件或电脑内容。" error={errInput}>
        <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={80} />
      </Field>
      <Field label="最多轮次" hint="每轮每个 Agent 最多发言一次；达到上限即结束。本人插话不消耗轮次。">
        <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>{n} 轮</option>
          ))}
        </select>
      </Field>
      <Field
        label="模拟预算上限"
        hint={`模拟计费：每次 Agent 发言计 ${TURN_COST} 点。按当前轮次全部发言约需 ${need} 点；先到达轮次或预算上限即结束，不会自动追加。`}
      >
        <select value={budget} onChange={(e) => setBudget(Number(e.target.value))}>
          {DISCUSSION_BUDGETS.map((n) => (
            <option key={n} value={n}>{n} 点{n < need ? "（不足以完成全部轮次，会提前结束）" : ""}</option>
          ))}
        </select>
      </Field>
      <div className="field">
        <span className="field-label">参与 Agent 与每轮发言顺序</span>
        <ol className="order-list">
          {order.map((id, i) => (
            <li key={id}>
              <Avatar id={id} size={28} />
              <span><IdentityLine id={id} /></span>
              <Btn small disabled={i === 0} onClick={() => moveUp(i)}>上移</Btn>
            </li>
          ))}
        </ol>
      </div>
      <div className="field">
        <span className="field-label">可见主人（需各自确认）</span>
        <ul className="member-rows compact">
          {owners.map((id) => (
            <li key={id}>
              <Avatar id={id} size={28} />
              <IdentityLine id={id} extra={<span className="owner">{id === ME ? "提交即确认" : "需其本人确认"}</span>} />
            </li>
          ))}
        </ul>
      </div>
      <Notice tone="info">
        可见人：{owners.map((id) => nameOf(state, id)).join("、")}。
        {others.length ? `需要${others.map((id) => nameOf(state, id)).join("、")}分别确认同一方案；确认后仍由你手动开始。` : "两个 Agent 属于同一主人，只需你确认一次。"}
      </Notice>
      {paused && <Reason>{nameOf(state, paused)}已暂停全部会话，方案可以提交，但开始前需要先恢复它。</Reason>}
    </Modal>
  );
}

function ShareModal({ conv, onClose }) {
  const { state, dispatch } = useStore();
  const targets = state.order.map((id) => state.convs[id]).filter((c) => c && canShareInto(state, c));
  const [target, setTarget] = useState(targets[0]?.id || "");
  const [picked, setPicked] = useState([]);
  const tc = state.convs[target];
  const frozen = tc ? publishBlock(state, tc) : null;
  const sourceOk = isOwnPrivate(state, conv);
  const why = !sourceOk
    ? "只能从你与自己 Agent 的私聊中选择摘要"
    : !tc
      ? "没有可分享的目标会话"
      : frozen
        ? "目标会话已冻结，不能发布"
        : !picked.length
          ? "请至少选择一条内容"
          : "";
  const asOwner = tc && !tc.members.includes(ME);
  const toggle = (line) => setPicked(picked.includes(line) ? picked.filter((x) => x !== line) : [...picked, line]);
  return (
    <Modal
      title="分享所选摘要"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn
            variant="primary"
            disabled={Boolean(why)}
            reason={why}
            onClick={() => {
              dispatch({ type: "share/create", convId: conv.id, target, items: SUMMARY_LINES.filter((l) => picked.includes(l)) });
              onClose();
            }}
          >
            生成分享确认
          </Btn>
        </>
      }
    >
      <p className="muted">来源（唯一）：你与{convTitle(state, conv)}的私聊。只分享下面勾选的内容，不会合并其他会话，也不会分享整段聊天或电脑画面。</p>
      <fieldset className="checks">
        <legend>选择要分享的摘要</legend>
        {SUMMARY_LINES.map((line, i) => (
          <label key={line}>
            <input type="checkbox" data-autofocus={i === 0 ? "" : undefined} checked={picked.includes(line)} onChange={() => toggle(line)} />
            <span>{line}</span>
          </label>
        ))}
      </fieldset>
      <Field label="目标会话">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((c) => (
            <option key={c.id} value={c.id}>
              {convTitle(state, c)}（{c.type === "agentGroup" ? "Agent 群 · 你以主人身份插话" : "混合群 · 你是发言成员"}）
            </option>
          ))}
        </select>
      </Field>
      {tc && (
        <>
          <div className="field">
            <span className="field-label">发言成员（成员版本 v{tc.version}）</span>
            <ul className="member-rows compact">
              {tc.members.map((id) => (
                <li key={id}>
                  <Avatar id={id} size={28} />
                  <IdentityLine id={id} />
                </li>
              ))}
            </ul>
          </div>
          <div className="field">
            <span className="field-label">全部可见人</span>
            <ul className="member-rows compact">
              {audience(state, tc).map((id) => (
                <li key={id}>
                  <Avatar id={id} size={28} />
                  <IdentityLine
                    id={id}
                    extra={
                      <span className="owner">
                        {[
                          humansIn(state, tc).includes(id) ? "发言成员" : "",
                          viewerOwners(state, tc).includes(id) ? `${agentsIn(state, tc).filter((a) => state.agents[a].ownerId === id).map((a) => nameOf(state, a)).join("、")}的主人` : "",
                        ].filter(Boolean).join(" · ")}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
          <Notice tone="info">
            {asOwner ? "你不是该群的发言成员：这条摘要会以你的「本人插话」发布，所有可见主人和群内 Agent 都会看到。" : "摘要会以你本人的名义发布，上面列出的可见人和群内 Agent 都会看到。"}
            这是一次单独的确认，不沿用任务授权，也不会转发任何旧群历史；成员名单变化后原确认作废，需重新发起。
          </Notice>
        </>
      )}
      <Reason>{why}</Reason>
    </Modal>
  );
}

function DiscussionBar({ conv, block, onSetup }) {
  const { state, dispatch } = useStore();
  const d = conv.discussion;
  const mine = myAgentsIn(state, conv);
  const pending = d ? Object.entries(d.approvals).filter(([, v]) => v === "pending").map(([id]) => nameOf(state, id)) : [];
  const cap = d?.budget != null ? ` · 模拟预算 ${d.spent || 0}/${d.budget} 点` : "";
  let text = "尚未设置讨论。关系确认不会自动开始讨论。";
  let actions = <Btn small variant="primary" disabled={Boolean(block)} reason={block?.text} onClick={onSetup}>设置讨论</Btn>;
  if (d?.status === "pendingApproval") {
    text = `讨论方案待确认：等待${pending.join("、")}确认 · 目标「${d.goal}」· 输入「${d.input}」· 最多 ${d.rounds} 轮${cap}`;
    actions = <Btn small onClick={() => dispatch({ type: "disc/end", convId: conv.id })}>撤回方案</Btn>;
  } else if (d?.status === "ready") {
    text = `讨论方案已确认 · 目标「${d.goal}」· 输入「${d.input}」· 最多 ${d.rounds} 轮${cap}`;
    actions = <Btn small variant="primary" disabled={Boolean(block)} reason={block?.text} onClick={() => dispatch({ type: "disc/start", convId: conv.id })}><Play size={14} aria-hidden="true" /> 开始讨论</Btn>;
  } else if (d?.status === "running") {
    text = `讨论进行中 · 第 ${d.round}/${d.rounds} 轮 · 下一位：${nameOf(state, d.order[d.turn])}${cap}`;
    actions = (
      <>
        <Btn small onClick={() => dispatch({ type: "disc/pause", convId: conv.id })}><Pause size={14} aria-hidden="true" /> 暂停本次讨论</Btn>
        <Btn small variant="text" onClick={() => dispatch({ type: "disc/end", convId: conv.id })}>结束</Btn>
      </>
    );
  } else if (d?.status === "paused") {
    text = `讨论已暂停 · 第 ${d.round}/${d.rounds} 轮${cap} · 目标「${d.goal}」· 输入「${d.input}」· 不会自动继续`;
    actions = (
      <>
        <Btn small variant="primary" disabled={Boolean(block)} reason={block?.text} onClick={() => dispatch({ type: "disc/resume", convId: conv.id })}>继续讨论</Btn>
        <Btn small variant="text" onClick={() => dispatch({ type: "disc/end", convId: conv.id })}>结束</Btn>
      </>
    );
  } else if (d?.status === "stale") {
    text = "成员已变化，原讨论方案失效。需使用新输入重新设置并确认。";
    actions = <Btn small variant="primary" disabled={Boolean(block)} reason={block?.text} onClick={onSetup}>重新设置讨论</Btn>;
  } else if (d?.status === "done") {
    text = "上一次讨论已结束。增加轮次或补充目标需要重新确认。";
  }
  return (
    <div className="disc-bar">
      <span className="disc-text">{text}</span>
      <span className="disc-actions">
        {actions}
        {mine.length > 0 && (
          <Btn small variant="text" onClick={() => dispatch({ type: "conv/toggleMyPause", convId: conv.id })}>
            {conv.myPause ? "恢复本会话中我的 Agent" : "暂停本会话中我的 Agent"}
          </Btn>
        )}
      </span>
    </div>
  );
}

export function ChatView({ conv }) {
  const { state, dispatch } = useStore();
  const [modal, setModal] = useState(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const endRef = useRef(null);
  const block = publishBlock(state, conv);
  const note = visibilityNote(state, conv);
  const group = conv.type === "mixed" || conv.type === "agentGroup";
  const hasDiscussion = supportsDiscussion(conv);
  const taskHost = conv.type === "agent" && conv.members.includes("travel");
  const task = taskHost ? activeTaskFor(state, conv.id) : null;
  const taskLive = isTaskOpen(task);
  const q = query.trim();
  const messages = q ? conv.messages.filter((x) => (x.text || "").toLowerCase().includes(q.toLowerCase())) : conv.messages;

  useEffect(() => {
    setSearching(false);
    setQuery("");
  }, [conv.id]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conv.id, conv.messages.length, conv.generating]);

  return (
    <section className="chat" aria-label={convTitle(state, conv)}>
      <header className="chat-head">
        <IconBtn label="返回列表" className="only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}><ChevronLeft size={22} /></IconBtn>
        <ConvAvatar conv={conv} size={56} />
        <div className="chat-title">
          <h2>{convTitle(state, conv)}</h2>
          <p>{convSubtitle(state, conv)}</p>
        </div>
        <div className="chat-head-actions">
          {taskLive && task.status !== "requested" && (
            <Btn className="boxed" onClick={() => dispatch({ type: "nav", patch: { taskOpen: !state.nav.taskOpen, detailsOpen: false } })}>
              <Monitor size={18} aria-hidden="true" /> 任务执行 · {taskPhase(task)[0]}
            </Btn>
          )}
          <IconBtn label="搜索本会话" className="boxed" aria-pressed={searching} onClick={() => (setSearching(!searching), setQuery(""))}><Search size={22} /></IconBtn>
          {group ? (
            <Btn className="boxed" onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "members" } })}>群资料</Btn>
          ) : null}
          <IconBtn label="会话资料" className="boxed" aria-pressed={state.nav.detailsOpen} onClick={() => dispatch({ type: "nav", patch: { detailsOpen: !state.nav.detailsOpen, taskOpen: false } })}><Menu size={22} /></IconBtn>
        </div>
      </header>

      {searching && (
        <div className="chat-search">
          <Search size={16} aria-hidden="true" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"){setQuery("");setSearching(false);}}} placeholder="在本会话中搜索" aria-label="在本会话中搜索" />
          <span className="muted">{q ? `${messages.length} 条结果` : ""}</span>
          <IconBtn label="关闭会话搜索" onClick={()=>{setQuery("");setSearching(false);}}><X size={16}/></IconBtn>
        </div>
      )}
      {note && (
        <div className="vis-banner">
          <Eye size={18} aria-hidden="true" /> {note}
        </div>
      )}
      <FreezeNotice
        conv={conv}
        extra={
          conv.expansion?.status === "pending" ? (
            <Btn small variant="primary" onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "expansion" } })}>查看扩员方案</Btn>
          ) : null
        }
      />
      {hasDiscussion && <DiscussionBar conv={conv} block={block} onSetup={() => setModal("discussion")} />}

      <ol className="messages">
        {q && messages.length === 0 && <li className="rows-empty" role="status">没有找到相关消息，请换个关键词</li>}
        {messages.map((msg) => (
          <MessageItem key={msg.id} msg={msg} conv={conv} onReply={block ? () => dispatch({ type: "toast", text: block.text }) : setReplyTo} />
        ))}
        {conv.generating && (
          <li className="msg theirs typing">
            <Avatar id={conv.generating.queue[0]} size={40} />
            <div className="msg-main">
              <div className="msg-meta"><strong>{nameOf(state, conv.generating.queue[0])}</strong><Tag>Agent</Tag></div>
              <div className="bubble"><span className="dots" aria-label="正在生成"><i /><i /><i /></span></div>
              <div className="msg-foot">
                <Btn small onClick={() => dispatch({ type: "gen/stop", convId: conv.id })}><Square size={12} aria-hidden="true" /> 停止生成</Btn>
              </div>
            </div>
          </li>
        )}
        {!conv.generating && conv.lastStopped?.length > 0 && (
          <li className="msg-system">
            <Btn small disabled={Boolean(block)} reason={block?.text} onClick={() => dispatch({ type: "gen/retry", convId: conv.id })}><RotateCw size={13} aria-hidden="true" /> 重新生成</Btn>
          </li>
        )}
        <li ref={endRef} aria-hidden="true" />
      </ol>

      {taskHost && (
        <div className="quick-bar">
          <Btn small disabled={Boolean(taskLive) || Boolean(block)} reason={taskLive ? "已有进行中的任务申请" : block?.text} onClick={() => dispatch({ type: "task/new", convId: conv.id })}>
            <Monitor size={14} aria-hidden="true" /> 让它申请一次电脑任务
          </Btn>
          <Btn small onClick={() => setModal("share")}><Share2 size={14} aria-hidden="true" /> 分享所选摘要到群聊</Btn>
          {taskLive && <span className="muted">已有进行中的任务申请</span>}
        </div>
      )}
      <Composer conv={conv} block={block} replyTo={replyTo} setReplyTo={setReplyTo} />
      {modal === "discussion" && <DiscussionModal conv={conv} onClose={() => setModal(null)} />}
      {modal === "share" && <ShareModal conv={conv} onClose={() => setModal(null)} />}
    </section>
  );
}
