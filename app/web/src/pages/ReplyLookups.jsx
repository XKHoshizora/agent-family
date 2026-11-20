// What an Agent's reply looked up with its tools, under the reply (design rule 15): one quiet line — 查了 n 次聊天记录,
// 看了 n 个文件, joined with ，; time lookups never in it — that opens, when there is something to open, the words its
// searches were for (in my Agent's own conversation only) and the messages it found that I can see (the service sends
// no more), each loaded as any one message is (`actions.foundMessage`, GET …/messages/:seq) and each jumping to its
// place (`onJump`: the chat's own useJumpTo, which outlives this list when the jump opens another conversation — the
// chat scrolls to the message and it flashes). A row loaded (or found gone) is kept while the reply is shown, so opening
// the line again loads nothing again; a row that failed for any other reason says so and is tried again next time. A
// reply that looked nothing up, or only at the time, shows nothing here.
import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { lookupLine, searchHitView } from "../data/viewmodel.js";
import { ChatHitRow } from "./SearchHits.jsx";

/** The line under `msg` (a view message) in `conv`, or nothing; `onJump(conversationId, seq)` opens a message found. */
export function ReplyLookups({ msg, conv, onJump }) {
  const [open, setOpen] = useState(false);
  /** What each row found loaded as, by `conversationId:seq`: kept across closing and opening the line. */
  const loaded = useRef(new Map());
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
                <FoundRow key={`${ref.conversationId}:${ref.seq}`} found={ref} onJump={onJump} kept={loaded.current} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One message the reply found: loading, then its sender, time and a line of it (a button that jumps to it); 看不到了 when
 * the service says it is not there for me (`not_found`), else that it could not be opened now. `kept`: the rows loaded
 * so far (a failure other than `not_found` is not kept: it is asked for again the next time the line opens).
 */
function FoundRow({ found, onJump, kept }) {
  const { state, actions } = useStore();
  const meId = state.account?.id ?? null;
  const key = `${found.conversationId}:${found.seq}`;
  const [loaded, setLoaded] = useState(() => kept.get(key) ?? null);
  useEffect(() => {
    if (kept.has(key)) return undefined;
    let live = true;
    actions.foundMessage(found.conversationId, found.seq).then((res) => {
      const now = res.ok ? { message: res.message } : res.error?.code === "not_found" ? { gone: true } : { failed: true };
      if (!now.failed) kept.set(key, now);
      if (live) setLoaded(now);
    });
    return () => {
      live = false;
    };
  }, [actions, kept, key, found.conversationId, found.seq]);
  if (loaded === null) return <li className="muted">正在加载…</li>;
  if (loaded.gone) return <li className="muted">这条消息已经看不到了</li>;
  if (loaded.failed) return <li className="muted">没能打开这条消息，请稍后再试</li>;
  const hit = searchHitView(loaded.message, { meId, now: Date.now() });
  return <ChatHitRow hit={hit} q="" onPick={() => onJump(found.conversationId, found.seq)} />;
}
