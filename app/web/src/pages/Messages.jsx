import React from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { publishBlock, senderName } from "../state/selectors.js";
import { Avatar, Btn, asset } from "../ui/primitives.jsx";
import { Reply, RotateCw, FileText, Check, CircleAlert } from "../icons.js";

/** The quoted message as the reader may see it: the service says whether it is visible to them. */
function Quote({ quote }) {
  const { state } = useStore();
  if (!quote) return null;
  if (!quote.visible) return <blockquote>引用的消息不在你的可见范围内</blockquote>;
  return (
    <blockquote>
      <strong>{quote.from ? senderName(state, quote.from) : ""}</strong>
      {quote.kind === "file" ? quote.attachmentName : quote.text}
    </blockquote>
  );
}

function Body({ msg }) {
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
  return (
    <div className="bubble">
      <Quote quote={msg.quote} />
      {msg.text}
    </div>
  );
}

export function MessageItem({ msg, conv, onReply }) {
  const { state, dispatch, actions } = useStore();
  if (msg.kind === "system")
    return (
      <li className="msg-system" data-msg={msg.id}>
        <span>{msg.text}</span>
      </li>
    );
  const mine = msg.from === ME;
  // Read state only in direct chats; "sending" is shown wherever it happens.
  const showReceipt = mine && conv.type === "human";
  const retry = () => {
    const block = publishBlock(state, conv);
    if (block) dispatch({ type: "toast", text: block.text });
    else actions.retrySend(msg.clientTxn);
  };
  return (
    <li className={`msg ${mine ? "mine" : "theirs"}`} data-msg={msg.id}>
      <Avatar id={msg.from} size={40} />
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{senderName(state, msg.from)}</strong>
          <time>{msg.at}</time>
        </div>
        <Body msg={msg} />
        <div className="msg-foot">
          {msg.status === "failed" ? (
            <>
              <span className="failed">
                <CircleAlert size={14} aria-hidden="true" /> 发送失败，未发布
              </span>
              <Btn small onClick={retry}>
                <RotateCw size={14} aria-hidden="true" /> 重试
              </Btn>
            </>
          ) : msg.status === "sending" ? (
            <span className="receipt">发送中…</span>
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
          {(msg.kind === "text" || msg.kind === "image") && msg.seq !== null && msg.status !== "failed" && msg.status !== "sending" && (
            <button type="button" className="msg-action" onClick={() => onReply(msg)}>
              <Reply size={15} aria-hidden="true" /> 回复
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
