// A message's text with its stored mentions shown as tags over their ranges (data/mentions.js): the text as it was sent,
// each mention a small tag. Who a tag means is the stored id; nothing here reads the text to decide it. A screen reader
// reads a tag as 提到 and the name (`MentionTag`).
import React from "react";
import { mentionName, mentionSegments } from "../data/mentions.js";

/**
 * One mention: its text as sent (`@Jarvis Lee`), shown as a tag; read as `提到 Jarvis Lee` (the hidden words are not
 * selected or copied with the text: styles.css `.mention .sr-only`). `id`: the principal it means.
 */
export function MentionTag({ text, id }) {
  return (
    <span className="mention" data-mention={id}>
      <span className="sr-only">{`提到 ${mentionName(text)}`}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

/** `text` with `mentions` (`[{id, start, length}]`, stored with the message) as tags; plain text without any. */
export function MentionText({ text, mentions }) {
  if (!Array.isArray(mentions) || mentions.length === 0) return text ?? "";
  return mentionSegments(text, mentions).map((part, i) =>
    part.mention ? <MentionTag key={i} text={part.text} id={part.mention.id} /> : <React.Fragment key={i}>{part.text}</React.Fragment>,
  );
}
