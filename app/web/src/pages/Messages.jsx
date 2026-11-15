import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { publishBlock, senderName } from "../state/selectors.js";
import { formatSize } from "../data/viewmodel.js";
import { failureText, retryHopeless } from "../data/uploadErrors.js";
import { Avatar, Btn } from "../ui/primitives.jsx";
import { Reply, RotateCw, FileText, Check, CircleAlert, Download } from "../icons.js";

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

/** What a file message says besides the file: the caption, and the quote when it replies to something. */
function Caption({ msg }) {
  if (!msg.caption && !msg.quote) return null;
  return (
    <div className="bubble">
      <Quote quote={msg.quote} />
      {msg.caption}
    </div>
  );
}

/** A file that cannot be shown or fetched (no longer visible to me, removed): neutral, no reason given. */
function UnavailableCard({ name }) {
  return (
    <div className="card file-card">
      <FileText size={28} aria-hidden="true" />
      <div>
        <strong>文件不可用</strong>
        <p className="muted">{name}</p>
      </div>
    </div>
  );
}

function ImageBody({ msg }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <UnavailableCard name={msg.text} />;
  return (
    <figure className="attachment-image">
      <a href={msg.src} target="_blank" rel="noopener" aria-label={`在新标签页打开图片 ${msg.text}`}>
        <img src={msg.src} alt={msg.text} loading="lazy" onError={() => setBroken(true)} />
      </a>
      <figcaption>{msg.text}</figcaption>
    </figure>
  );
}

function FileBody({ msg }) {
  const { upload, attachment } = msg;
  return (
    <div className="card file-card">
      <FileText size={28} aria-hidden="true" />
      <div>
        <strong>{msg.text}</strong>
        <p className="muted">{formatSize(attachment.size)} · 仅本会话可见</p>
        {upload && <progress className="upload-progress" max={100} value={Math.round(upload.progress * 100)} aria-label="上传进度" />}
        {attachment.url && (
          <div className="card-actions">
            <a className="btn btn-ghost btn-sm" href={attachment.url} download={attachment.name}>
              <Download size={14} aria-hidden="true" /> 下载
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function Body({ msg }) {
  if (msg.kind === "image" || msg.kind === "file")
    return (
      <>
        {msg.kind === "image" ? <ImageBody msg={msg} /> : <FileBody msg={msg} />}
        <Caption msg={msg} />
      </>
    );
  return (
    <div className="bubble">
      <Quote quote={msg.quote} />
      {msg.text}
    </div>
  );
}

export function MessageItem({ msg, conv, onReply, flash = false }) {
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
  const cancelUpload = () => actions.cancelUpload(msg.clientTxn);
  const retry = () => {
    const block = publishBlock(state, conv);
    if (block) dispatch({ type: "toast", text: block.text });
    else actions.retrySend(msg.clientTxn);
  };
  return (
    <li className={`msg ${mine ? "mine" : "theirs"}${flash ? " flash" : ""}`} data-msg={msg.id}>
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
              {msg.kind === "file" && <span className="muted">{failureText(msg.error)}</span>}
              {!(msg.kind === "file" && retryHopeless(msg.error)) && (
                <Btn small onClick={retry}>
                  <RotateCw size={14} aria-hidden="true" /> 重试
                </Btn>
              )}
              {msg.upload === null && msg.kind === "file" && !msg.attachment.id && (
                <Btn small onClick={cancelUpload}>
                  取消
                </Btn>
              )}
            </>
          ) : msg.upload ? (
            <>
              <span className="receipt">{msg.upload.phase === "queued" ? "等待上传…" : `上传中 ${Math.round(msg.upload.progress * 100)}%`}</span>
              <Btn small onClick={cancelUpload}>
                取消
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
