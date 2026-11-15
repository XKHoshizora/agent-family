import React from "react";
import { useStore } from "../state/store.jsx";
import { ME } from "../data/identities.js";
import { nameOf, ownerOf, convTitle, myBlock, isMine } from "../state/selectors.js";
import { Modal, Btn, Notice } from "../ui/primitives.jsx";

export function sharedConvs(state, target) {
  return Object.values(state.convs).filter(
    (c) => c.members.includes(target) && c.members.some((id) => id !== target && (id === ME || isMine(state, id))),
  );
}

export function BlockModal({ target, onClose }) {
  const { state, dispatch } = useStore();
  const blocked = Boolean(myBlock(state, target));
  const name = nameOf(state, target);
  const owner = nameOf(state, ownerOf(state, target));
  const shared = sharedConvs(state, target);
  const myAgents = Object.values(state.agents).filter((a) => a.ownerId === ME).map((a) => a.name);
  return (
    <Modal
      title={blocked ? `解除对${name}的拉黑` : `拉黑${name}`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn
            variant={blocked ? "primary" : "danger"}
            onClick={() => {
              dispatch({ type: blocked ? "block/remove" : "block/add", target });
              onClose();
            }}
          >
            {blocked ? "解除我的拉黑" : "确认拉黑"}
          </Btn>
        </>
      }
    >
      {blocked ? (
        <>
          <p>只解除你自己的拉黑。其他人对相关 Agent 的拉黑不受影响，仍需由对方解除。</p>
          <Notice tone="info">解除拉黑不会恢复好友、不授予工具，也不会自动恢复群讨论；受影响的会话需检查后手动恢复。</Notice>
        </>
      ) : (
        <>
          <p>
            范围：你本人及你的 Agent（{myAgents.join("、")}）与 <strong>{name}</strong> 之间的直接新互动。
          </p>
          <ul className="plain-list">
            <li>不会拉黑其主人{owner}，也不会拉黑{owner}的其他 Agent。</li>
            <li>{name}与其他人的不相干会话不受影响。</li>
            <li>已合法取得的历史可能仍可查看。</li>
          </ul>
          {shared.length > 0 && (
            <Notice tone="pause">
              以下共同会话的新增消息、附件与讨论将被冻结：{shared.map((c) => convTitle(state, c)).join("、")}。
            </Notice>
          )}
        </>
      )}
    </Modal>
  );
}
