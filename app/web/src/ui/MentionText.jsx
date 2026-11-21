// A message's text with its stored mentions shown as tags over their ranges (data/mentions.js): the text as it was sent,
// each mention a small tag. Who a tag means is the stored id; nothing here reads the text to decide it. A screen reader
// reads a tag as 提到 and the name of whom it means now (`MentionTag`), its tooltip says the same, an Agent's with its
// owner, and an Agent's tag is drawn apart from a person's.
import React from "react";
import { CitedText } from "./cites.jsx";
import { mentionName, mentionSegments } from "../data/mentions.js";
import { useStore } from "../data/store.jsx";
import { entity, isAgent, nameOf, ownerOf } from "../state/selectors.js";

/**
 * One mention: its text as sent (`@Jarvis Lee`), shown as a tag; read as `提到` and the current name of the principal
 * it means (`id`; the text after its "@" when that is not known, or outside the app's store), with that name as its
 * tooltip — for an Agent `{name} · Agent · 主人：{owner}`. The hidden words are not selected or copied with the text
 * (styles.css `.mention .sr-only`).
 */
export function MentionTag({ text, id }) {
  const state = useStore()?.state ?? null;
  const known = state && id ? entity(state, id) : null;
  const name = known?.name || mentionName(text);
  const agent = Boolean(state && id && isAgent(state, id));
  const title = agent ? `${name} · Agent · 主人：${nameOf(state, ownerOf(state, id))}` : name;
  return (
    <span className={agent ? "mention mention-agent" : "mention"} data-mention={id ?? undefined} title={title}>
      <span className="sr-only">{`提到 ${name}`}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

/** `text` with `mentions` (`[{id, start, length}]`, stored with the message) as tags; plain text without any. */
export function MentionText({ text, mentions }) {
  if (!Array.isArray(mentions) || mentions.length === 0) return text ?? "";
  return mentionSegments(text, mentions).map((part, i) =>
    part.mention ? <MentionTag key={i} text={part.text} id={part.mention.id} /> : <CitedText key={i} text={part.text} />,
  );
}
