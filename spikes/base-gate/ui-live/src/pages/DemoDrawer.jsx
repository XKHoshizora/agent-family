import React, { useEffect, useRef } from "react";
import { useStore } from "../state/store.jsx";
import { ME } from "../data/identities.js";
import { convTitle, nameOf, ownerOf, viewerOwners, humansIn } from "../state/selectors.js";
import { Btn, IconBtn, Reason } from "../ui/primitives.jsx";
import { X } from "../icons.js";

function Group({ title, children }) {
  return (
    <section className="demo-group">
      <h3>{title}</h3>
      <div className="demo-actions">{children}</div>
    </section>
  );
}

export function DemoDrawer() {
  const { state, dispatch } = useStore();
  const ref = useRef(null);
  const close = () => dispatch({ type: "nav", patch: { demoOpen: false } });
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const conv = state.nav.section === "chat" ? state.convs[state.nav.convId] : null;
  const e = conv?.expansion?.status === "pending" ? conv.expansion : null;
  const d = conv?.discussion?.status === "pendingApproval" ? conv.discussion : null;
  const rec = conv?.recovery?.status === "pending" ? conv.recovery : null;
  const awaitingStop = Object.values(state.tasks).filter((t) => t.control === "pendingStop");
  const stepping = Object.values(state.tasks).filter((t) => t.status === "running" && t.control === "agent");
  const otherOwners = conv ? viewerOwners(state, conv).filter((id) => id !== ME) : [];
  const otherHumans = conv ? humansIn(state, conv).filter((id) => id !== ME) : [];
  // Same-owner relations never wait for an external response, so they are never listed here.
  const outgoing = Object.entries(state.relations).filter(([key, r]) => {
    const [a, b] = key.split("|");
    return r.status === "pending" && ownerOf(state, a) !== ownerOf(state, b);
  });
  const xlBlock = state.blocks.some((b) => b.by === "xiaolin" && b.target === "travel");
  const requested = Object.values(state.tasks).filter((t) => t.status === "requested");
  const pendingShares = Object.values(state.shares).filter((s) => s.status === "pending");
  const { V01, A } = state.devices;
  const sim = (action) => dispatch(action);

  return (
    <aside
      className="demo-drawer"
      role="dialog"
      aria-label="演示状态"
      tabIndex={-1}
      ref={ref}
      onKeyDown={(ev) => ev.key === "Escape" && close()}
    >
      <header className="side-head">
        <h2>演示状态</h2>
        <IconBtn label="关闭" onClick={close}><X size={18} /></IconBtn>
      </header>
      <div className="side-body">
        <Reason>这里只模拟其他人或外部环境的变化（模拟对方确认）。它们不代表你的权限，你自己的决定请在正常界面里操作。</Reason>

        <Group title={conv ? `当前会话：${convTitle(state, conv)}` : "当前会话"}>
          {!conv && <span className="muted">打开一个会话后可模拟其中的事件</span>}
          {e &&
            Object.entries(e.approvals)
              .filter(([id, v]) => id !== ME && v === "pending")
              .flatMap(([id]) => [
                <Btn small key={`a${id}`} onClick={() => sim({ type: "sim/expResolve", convId: conv.id, who: id, result: "approve" })}>模拟{nameOf(state, id)}确认扩员</Btn>,
                <Btn small key={`r${id}`} onClick={() => sim({ type: "sim/expResolve", convId: conv.id, who: id, result: "reject" })}>模拟{nameOf(state, id)}拒绝扩员</Btn>,
              ])}
          {e && e.initiator !== ME && <Btn small onClick={() => sim({ type: "sim/expResolve", convId: conv.id, result: "withdraw" })}>模拟发起人{nameOf(state, e.initiator)}撤回</Btn>}
          {e && <Btn small onClick={() => sim({ type: "sim/expResolve", convId: conv.id, result: "expire" })}>模拟扩员方案过期</Btn>}
          {d &&
            Object.entries(d.approvals)
              .filter(([id, v]) => id !== ME && v === "pending")
              .flatMap(([id]) => [
                <Btn small key={`da${id}`} onClick={() => sim({ type: "sim/discResolve", convId: conv.id, who: id, ok: true })}>模拟{nameOf(state, id)}确认讨论方案</Btn>,
                <Btn small key={`dr${id}`} onClick={() => sim({ type: "sim/discResolve", convId: conv.id, who: id, ok: false })}>模拟{nameOf(state, id)}拒绝讨论方案</Btn>,
              ])}
          {rec &&
            Object.entries(rec.approvals)
              .filter(([id, v]) => id !== ME && v === "pending")
              .flatMap(([id]) => [
                <Btn small key={`ra${id}`} onClick={() => sim({ type: "sim/recoverResolve", convId: conv.id, who: id, result: "approve" })}>模拟{nameOf(state, id)}确认恢复方案 v{rec.version}</Btn>,
                <Btn small key={`rr${id}`} onClick={() => sim({ type: "sim/recoverResolve", convId: conv.id, who: id, result: "reject" })}>模拟{nameOf(state, id)}拒绝恢复方案</Btn>,
              ])}
          {rec && <Btn small onClick={() => sim({ type: "sim/recoverResolve", convId: conv.id, result: "expire" })}>模拟恢复方案过期</Btn>}
          {conv && otherOwners.length > 0 && (
            <Btn small onClick={() => sim({ type: "sim/visibility", convId: conv.id, down: conv.visibility !== "down" })}>
              {conv.visibility === "down" ? "模拟主人可见恢复正常" : `模拟${nameOf(state, otherOwners[0])}暂时无法查看`}
            </Btn>
          )}
          {conv && otherHumans.length > 0 && <Btn small onClick={() => sim({ type: "sim/peerMessage", convId: conv.id })}>模拟{nameOf(state, otherHumans[0])}发来消息</Btn>}
        </Group>

        <Group title="联系申请">
          {outgoing.flatMap(([key]) => {
            const [a, b] = key.split("|");
            const label = `${nameOf(state, a)} → ${nameOf(state, b)}`;
            return [
              <Btn small key={`${key}e`} onClick={() => sim({ type: "sim/relResolve", key, result: "established" })}>模拟对方同意（{label}）</Btn>,
              <Btn small key={`${key}r`} onClick={() => sim({ type: "sim/relResolve", key, result: "rejected" })}>模拟对方拒绝</Btn>,
              <Btn small key={`${key}x`} onClick={() => sim({ type: "sim/relResolve", key, result: "expired" })}>模拟 24 小时过期</Btn>,
            ];
          })}
          <Btn small onClick={() => sim({ type: "sim/incoming" })}>模拟收到新申请（小林的摄影助手 → 我的旅行助手）</Btn>
        </Group>

        <Group title="拉黑">
          <Btn small onClick={() => sim({ type: "sim/block", by: "xiaolin", target: "travel", on: !xlBlock })}>
            {xlBlock ? "模拟小林解除对我的旅行助手的拉黑" : "模拟小林拉黑我的旅行助手"}
          </Btn>
        </Group>

        <Group title="消息">
          <Btn small aria-pressed={state.sim.failNext} onClick={() => sim({ type: "sim/failNext" })}>
            {state.sim.failNext ? "取消：下一条消息发送失败" : "让我的下一条消息发送失败"}
          </Btn>
        </Group>

        <Group title="设备与任务">
          <Btn small onClick={() => sim({ type: "sim/device", deviceId: "V01", online: !V01.online })}>{V01.online ? "模拟 V-01 离线" : "模拟 V-01 恢复在线"}</Btn>
          <Btn small disabled={Boolean(A.heldBy) && A.heldBy !== "other"} onClick={() => sim({ type: "sim/device", deviceId: "A", busy: !A.busy })}>
            {A.busy ? "模拟电脑 A 空闲" : "模拟电脑 A 被占用"}
          </Btn>
          {awaitingStop.map((t) => (
            <Btn
              small
              key={`ack${t.id}`}
              disabled={!state.devices[t.deviceId].online}
              reason="设备离线，收不到确认"
              onClick={() => sim({ type: "sim/deviceStopAck", taskId: t.id })}
            >
              模拟设备事件：电脑确认 Agent 已停止{state.devices[t.deviceId].online ? "" : "（设备离线，不可用）"}
            </Btn>
          ))}
          {stepping.map((t) => (
            <Btn small key={`tick${t.id}`} onClick={() => sim({ type: "task/tick", taskId: t.id, token: t.token })}>演示：任务立即进入下一步（仍会重新检查）</Btn>
          ))}
          {requested.map((t) => (
            <Btn small key={t.id} onClick={() => sim({ type: "task/decline", taskId: t.id, result: "expired" })}>模拟任务申请过期</Btn>
          ))}
          {pendingShares.map((s) => (
            <Btn small key={s.id} onClick={() => sim({ type: "share/close", id: s.id, result: "expired" })}>模拟分享确认过期</Btn>
          ))}
        </Group>
      </div>
    </aside>
  );
}
