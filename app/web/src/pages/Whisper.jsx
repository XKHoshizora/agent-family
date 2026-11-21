// A whisper (悄悄话): a small note in a conversation that only I see, about my Agent there (app/service/README.md
// "Whispers"). Not a message — no sender, no time, nothing to quote —, it sits after the message it follows (ChatView,
// `placeWhispers`). Open: a small bubble with a lock, 只有你能看到, its text and the buttons it offers (告诉他们, 不用), one
// decision at a time (`useDecision`), a refusal said on it. Answered or expired: a quiet line. One that offers no button
// (it only tells, such as a model turned to plain chat, `tools_off`) has nothing to answer: it stays that note, with its
// text, whatever its status. An open `found_elsewhere` one shows what was found before its buttons (`hits`: where · who
// · when, then the text, a long one folded with 展开), so that I see what I would tell. Only a stale answer
// (`stale_whisper`) takes the buttons away; a refusal of the reply 告诉他们 would start (it is replying, paused, has no
// model, too many replies a minute) says why and leaves them. Following MemoryNotice.
import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { Lock } from "../icons.js";
import { Btn } from "../ui/primitives.jsx";
import { useDecision } from "./AgentChatBits.jsx";

/** What an answered whisper still says. */
export const WHISPER_DONE = { accepted: "已告诉他们", declined: "已忽略", expired: "已过期" };
/** The line every open whisper starts with. */
export const ONLY_YOU = "只有你能看到";
/** A hit's text longer than this many characters is folded to a few lines (styles.css `.folded`), with 展开 / 收起. */
export const HIT_FOLD_AT = 80;

/** One thing a `found_elsewhere` whisper found: where · who · when, then what was said (React text only). */
function Hit({ hit }) {
  const [open, setOpen] = useState(false);
  const long = [...hit.text].length > HIT_FOLD_AT;
  return (
    <li className="whisper-hit">
      <p className="whisper-hit-meta">{[hit.where, hit.who, hit.when].join(" · ")}</p>
      <p className={long && !open ? "whisper-hit-text folded" : "whisper-hit-text"}>{hit.text}</p>
      {long && (
        <button type="button" className="whisper-hit-more" onClick={() => setOpen((o) => !o)}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </li>
  );
}

/** One whisper of mine (`whisper`: a view of `conv.whispers`) in the conversation `conv`. */
export function Whisper({ whisper, conv }) {
  const { actions } = useStore();
  const { mounted, busy, refusal, decide } = useDecision();
  // Refused as stale (answered or expired meanwhile): nothing more is offered until it is read again.
  const [stale, setStale] = useState(false);

  // One that offers no button was never waiting for an answer: expired, it still says what it told.
  if (whisper.status !== "open" && whisper.actions.length > 0) {
    return (
      <li className="msg-whisper whisper-done" data-whisper={whisper.id}>
        <span className="muted">
          <Lock size={12} aria-hidden="true" />
          {WHISPER_DONE[whisper.status] ?? WHISPER_DONE.expired}
        </span>
      </li>
    );
  }

  const answer = async (key) => {
    const res = await decide(key, actions.answerWhisper(conv.id, whisper.id, key));
    if (mounted.current && !res.ok && res.error?.code === "stale_whisper") setStale(true);
  };
  const offers = (action) => !stale && whisper.actions.includes(action);
  return (
    <li className="msg-whisper" data-whisper={whisper.id}>
      <div className="whisper" role="note" aria-label={ONLY_YOU}>
        <p className="whisper-head">
          <Lock size={12} aria-hidden="true" />
          {ONLY_YOU}
        </p>
        <p className="whisper-text">{whisper.text}</p>
        {Array.isArray(whisper.hits) && whisper.hits.length > 0 && (
          <ul className="whisper-hits">
            {whisper.hits.map((hit, i) => (
              <Hit key={i} hit={hit} />
            ))}
          </ul>
        )}
        {(offers("tell") || offers("dismiss")) && (
          <div className="whisper-actions">
            {offers("tell") && (
              <Btn small variant="primary" disabled={busy !== null} onClick={() => answer("accept")}>
                {busy === "accept" ? "处理中…" : "告诉他们"}
              </Btn>
            )}
            {offers("dismiss") && (
              <Btn small variant="text" disabled={busy !== null} onClick={() => answer("decline")}>
                {busy === "decline" ? "处理中…" : "不用"}
              </Btn>
            )}
          </div>
        )}
        {refusal && (
          <p className="field-msg" role="alert">
            {refusal}
          </p>
        )}
      </div>
    </li>
  );
}
