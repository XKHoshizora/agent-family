import React from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { isAgent, nameOf, ownerOf } from "../state/selectors.js";
import { Avatar, Tag, Btn, asset } from "../ui/primitives.jsx";
import { Reply, RotateCw, FileText, Check, CircleAlert } from "../icons.js";

function Body({ msg, conv }) {
  const { state } = useStore();
  if (msg.kind === "image")
    return (
      <figure className="attachment-image">
        <img src={asset(msg.src)} alt={msg.text} />
        <figcaption>{msg.text}</figcaption>
      </figure>
    );
  if (msg.kind === "file")
    return (
      <div className="card file-card">
        <FileText size={28} aria-hidden="true" />
        <div>
          <strong>{msg.text}</strong>
          <p className="muted">仅本会话可见</p>
        </div>
      </div>
    );
  const quoted = msg.replyTo ? conv.messages.find((x) => x.id === msg.replyTo) : null;
  return (
    <div className="bubble">
      {quoted && (
        <blockquote>
          <strong>{quoted.from ? nameOf(state, quoted.from) : ""}</strong>
          {quoted.kind === "image" ? "[图片]" : quoted.text}
        </blockquote>
      )}
      {msg.text}
    </div>
  );
}

export function MessageItem({ msg, conv, onReply }) {
  const { state, dispatch } = useStore();
  if (msg.kind === "system")
    return (
      <li className="msg-system">
        <span>{msg.text}</span>
      </li>
    );
  const mine = msg.from === ME;
  const agent = isAgent(state, msg.from);
  const showReceipt = mine && conv.type === "human";
  return (
    <li className={`msg ${mine ? "mine" : "theirs"}`}>
      <Avatar id={msg.from} size={40} />
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{nameOf(state, msg.from)}</strong>
          {agent && <Tag>Agent</Tag>}
          {agent && <span className="owner">主人：{nameOf(state, ownerOf(state, msg.from))}</span>}
          {msg.interject && <Tag tone="human">本人插话</Tag>}
          <time>{msg.at}</time>
        </div>
        <Body msg={msg} conv={conv} />
        <div className="msg-foot">
          {msg.status === "failed" ? (
            <>
              <span className="failed">
                <CircleAlert size={14} aria-hidden="true" /> 发送失败，未发布
              </span>
              <Btn small onClick={() => dispatch({ type: "msg/retry", convId: conv.id, msgId: msg.id })}>
                <RotateCw size={14} aria-hidden="true" /> 重试
              </Btn>
            </>
          ) : (
            showReceipt && (
              <span className="receipt">
                {msg.status === "read" ? (
                  <>
                    <Check size={13} aria-hidden="true" /> 已读
                  </>
                ) : (
                  "已发送"
                )}
              </span>
            )
          )}
          {(msg.kind === "text" || msg.kind === "image") && msg.status !== "failed" && (
            <button type="button" className="msg-action" onClick={() => onReply(msg)}>
              <Reply size={15} aria-hidden="true" /> 回复
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
