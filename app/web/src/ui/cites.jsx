// What an Agent's reply cites (design rule 4; the service's `cites`): the reply writes 〔m3〕 after what it found, and each
// reader is sent, for the numbers it wrote, the messages that reader can see. Such a 〔mN〕 is shown as a small
// superscript link to its message (the chat's own jump: it scrolls there, opening its conversation when it is another,
// and the message flashes); a 〔mN〕 the reader is sent nothing for stays the text it is. A reply's text is plain or
// rendered Markdown (AgentText.jsx, Markdown.jsx): both read the citations of the message they show from `CitesContext`.
import React, { createContext, Fragment, useContext } from "react";

/** The citations of the message being shown, `{ cites: { m3: { conversationId, seq } }, onJump }`, or null. */
export const CitesContext = createContext(null);

const CITATION = /〔(m[1-9][0-9]{0,5})〕/g;

function Cite({ number, at, onJump }) {
  const n = number.slice(1);
  return (
    <sup className="cite">
      <button type="button" title="跳到引用的消息" aria-label={`引用 ${n}`} onClick={() => onJump(at.conversationId, at.seq)}>
        {n}
      </button>
    </sup>
  );
}

/**
 * `text` with every 〔mN〕 that `value.cites` names as a `Cite`; the text itself when there is none (or no `value`).
 * `key` keeps the pieces apart among other children.
 */
export function withCites(text, value, key = "c") {
  if (!value || typeof text !== "string" || !text.includes("〔")) return text;
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(CITATION)) {
    const at = Object.hasOwn(value.cites, m[1]) ? value.cites[m[1]] : null;
    if (!at) continue;
    if (m.index > last) parts.push(<Fragment key={`${key}-t${last}`}>{text.slice(last, m.index)}</Fragment>);
    parts.push(<Cite key={`${key}-c${m.index}`} number={m[1]} at={at} onJump={value.onJump} />);
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(<Fragment key={`${key}-t${last}`}>{text.slice(last)}</Fragment>);
  return <Fragment key={key}>{parts}</Fragment>;
}

/** A plain text, with the citations of the message being shown. */
export function CitedText({ text }) {
  return withCites(text, useContext(CitesContext));
}
