// What an Agent's reply looked up with its tools, under the reply (design rule 15): one quiet line — 查了 n 次聊天记录,
// 看了 n 个文件, joined with ，; time lookups never in it — that opens, when there is something to open, the words its
// searches were for (in my Agent's own conversation only) and the messages it found that I can see (the service sends
// no more), each loaded as any one message is (`actions.foundMessage`, GET …/messages/:seq) and each jumping to its
// place (`onJump`: the chat's own useJumpTo, which outlives this list when the jump opens another conversation — the
// chat scrolls to the message and it flashes). A reply that looked nothing up, or only at the time, shows nothing here.
import React, { useEffect, useState } from "react";
import { useStore } from "../data/store.jsx";
import { lookupLine, searchHitView } from "../data/viewmodel.js";
import { ChatHitRow } from "./SearchHits.jsx";

/** The line under `msg` (a view message) in `conv`, or nothing; `onJump(conversationId, seq)` opens a message found. */
export function ReplyLookups({ msg, conv, onJump }) {
  const [open, setOpen] = useState(false);
  const line = lookupLine(msg.lookups);
  if (!line) return null;
  // The words are its owner's, in its own conversation: never shown in a group, whatever the message carries.
  const words = conv.type === "agent" ? msg.queries ?? [] : [];
  const found = msg.found ?? [];
  if (found.length === 0 && words.length === 0) return <p className="msg-lookups">{line}</p>;
  return (
    <div className="msg-lookups">
      <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        {line}
      </button>
      {open && (
        <>
          {words.length > 0 && <p className="lookup-words">搜索词：{words.join("、")}</p>}
          {found.length > 0 && (
            <ul className="lookup-rows">
              {found.map((ref) => (
                <FoundRow key={`${ref.conversationId}:${ref.seq}`} found={ref} onJump={onJump} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** One message the reply found: loading, then its sender, time and a line of it (a button that jumps to it), or 看不到了. */
function FoundRow({ found, onJump }) {
  const { state, actions } = useStore();
  const meId = state.account?.id ?? null;
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    let live = true;
    actions.foundMessage(found.conversationId, found.seq).then((res) => {
      if (live) setLoaded(res.ok ? { message: res.message } : { gone: true });
    });
    return () => {
      live = false;
    };
  }, [actions, found.conversationId, found.seq]);
  if (loaded === null) return <li className="muted">正在加载…</li>;
  if (loaded.gone) return <li className="muted">这条消息已经看不到了</li>;
  const hit = searchHitView(loaded.message, { meId, now: Date.now() });
  return <ChatHitRow hit={hit} q="" onPick={() => onJump(found.conversationId, found.seq)} />;
}
