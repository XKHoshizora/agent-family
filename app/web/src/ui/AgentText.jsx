// An Agent's text in its bubble, stored or being written. It is shown as plain text at once (as a person's message is;
// a reply being written in its own bubble is revealed a little at every frame instead, ui/reveal.js),
// and as Markdown once the Markdown worker's tree for it has come back and been checked (markdownClient.js): no
// spinner, nothing moves but the change from plain to rich. Nothing here parses, typesets or highlights. Shown plain:
// while the tree is coming; for a text not near the visible part of its conversation, or pushed out of the
// conversation's element budget (markdownView.jsx); with a note, for a text too complex or too slow to render; without
// one, where there is no worker. A tree the client already holds (the conversation was open before) is no different
// from one the worker has yet to make: the text mounts plain, its tree is taken only once it is near, and every tree is
// shown at an animation frame, a few per frame (markdownView.jsx `inFrame`). Bidirectional controls are taken out of
// the text before it is shown either way.
import React, { Suspense, memo, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChunkBoundary } from "./ChunkBoundary.jsx";
import { DROPPED, markdownClient, withNote } from "./markdownClient.js";
import { withoutBidiControls } from "./markdownRules.js";
import { inFrame, useMarkdownView } from "./markdownView.jsx";
import { useReveal } from "./reveal.js";
import { PlainWithNote, SLOW_TEXT_NOTE } from "./slowTexts.jsx";

/** A reply being written asks for its tree at most this often, in milliseconds. */
export const STREAM_EVERY_MS = 300;
/** Late answers in a row after which the rest of a reply being written stays plain. */
const STREAM_LATE_MAX = 2;

/** The chunk that shows a tree (ui/Markdown.jsx), asked for the first time a tree is asked for, then kept. */
let markdownChunk = null;

/**
 * Starts loading the chunk that shows trees (once) and returns it; `use` reads it at once when it has arrived. A chunk
 * that could not be loaded is not asked for again (a stale tab reloads itself: staleChunk.js). `load`: tests.
 */
export function loadMarkdown(load = () => import("./Markdown.jsx")) {
  if (!markdownChunk) {
    const chunk = Object.assign(load(), { status: "pending" });
    chunk.then(
      (value) => {
        Object.assign(chunk, { status: "fulfilled", value });
      },
      (reason) => {
        Object.assign(chunk, { status: "rejected", reason });
      },
    );
    markdownChunk = chunk;
  }
  return markdownChunk;
}

/** The tree, once its chunk is here (suspends until then); says when it is shown (its height changed). */
function LoadedTree({ tree, view }) {
  const { RichTree } = use(loadMarkdown());
  useLayoutEffect(() => view.changed(), [view, tree]);
  return <RichTree tree={tree} />;
}

/** A checked tree shown, or `plain` while its chunk loads, if it cannot be loaded, or if showing it fails. */
function Rich({ tree, plain, view }) {
  if (markdownChunk?.status === "rejected") return plain;
  return (
    <ChunkBoundary fallback={plain} resetKey={tree}>
      <Suspense fallback={plain}>
        <LoadedTree tree={tree} view={view} />
      </Suspense>
    </ChunkBoundary>
  );
}

/** Tells the view when what a text shows changes kind (plain, with the note, rich): its height may have changed. */
function useShownKind(view, kind) {
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) first.current = false;
    else view.changed();
  }, [view, kind]);
}

/** A plain result as shown: the text, with the note when it was too complex or too slow. */
const plainOf = (text, result) => (withNote(result) ? <PlainWithNote text={text} /> : text);

/**
 * Shows `rendered` elements of a tree if the conversation's budget allows (it may push others far from view back to
 * plain), until the tree changes, the text goes, or this text is pushed back itself; asks again when it comes near.
 * `framed`: the budget is asked at an animation frame, in the frame's turn (a stored text turning rich); otherwise at
 * once (a reply being written, whose trees are taken at a frame already and replace one another without a gap).
 */
function useBudget(view, host, result, epoch, framed) {
  const [grantedFor, setGrantedFor] = useState(null);
  /** The ticket of the tree shown (or refused) now. */
  const ticket = useRef(null);
  useLayoutEffect(
    () => () => {
      ticket.current?.release();
      ticket.current = null;
    },
    [view, host, result],
  );
  useLayoutEffect(() => {
    if (!result?.tree || ticket.current?.granted) return undefined;
    const claim = () => {
      ticket.current = view.claim(host.current, result.rendered, () => setGrantedFor(null));
      setGrantedFor(ticket.current.granted ? result : null);
    };
    if (framed) return inFrame(result.elements, () => view.distance(host.current), claim);
    claim();
    return undefined;
  }, [view, host, result, epoch, framed]);
  return Boolean(result?.tree) && grantedFor === result;
}

/** Whether the element is near the visible part of its conversation; `epoch` counts its comings near. */
function useNear(view, host, id) {
  const [near, setNear] = useState(false);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let was = false;
    return view.watch(host.current, id, (now) => {
      if (now && !was) setEpoch((n) => n + 1);
      was = now;
      setNear(now);
    });
  }, [view, host, id]);
  return { near, epoch };
}

/** What is known of a text without its tree: that it is shown plain (too long, slow before, no workers), or nothing. */
const plainKnown = (client, text) => {
  const known = client.peek(text);
  return known?.plain ? known : null;
};

/**
 * The text of an Agent's stored message. `id`: the message's (where the browser cannot tell what is near, the newest
 * Agent texts are). Asked for once near — of the worker or of the answers the client has kept, alike; once rich it
 * stays rich while shown (unless the budget pushes it back).
 */
export const AgentText = memo(function AgentText({ text, id = null }) {
  const shown = useMemo(() => withoutBidiControls(text), [text]);
  const client = markdownClient();
  const view = useMarkdownView();
  const host = useRef(null);
  const { near, epoch } = useNear(view, host, id);
  const [held, setHeld] = useState(() => ({ text: shown, result: plainKnown(client, shown) }));
  const result = held.text === shown ? held.result : null;

  useEffect(() => {
    if (result) return undefined;
    const now = plainKnown(client, shown);
    if (now) {
      setHeld({ text: shown, result: now });
      return undefined;
    }
    if (!near) return undefined;
    loadMarkdown();
    let wanted = true;
    client.request(shown, { wanted: () => wanted, priority: () => view.distance(host.current) }).then((answer) => {
      if (wanted && answer !== DROPPED) setHeld({ text: shown, result: answer });
    });
    return () => {
      wanted = false;
    };
  }, [client, view, shown, near, result]);

  const granted = useBudget(view, host, result, epoch, true);
  let body = shown;
  let kind = "plain";
  if (result?.plain) {
    body = plainOf(shown, result);
    kind = withNote(result) ? "note" : "plain";
  } else if (result?.tree && granted) {
    body = <Rich tree={result.tree} plain={shown} view={view} />;
    kind = "rich";
  }
  useShownKind(view, kind);
  return (
    <div className="md-text" ref={host}>
      {body}
    </div>
  );
});

/**
 * Which text this is: the same number while each text extends the one before (a reply growing by its pieces), the
 * next one when it does not. Checked once per new text, never per frame.
 */
function useEpoch(text) {
  const held = useRef({ text: "", epoch: 0 });
  return useMemo(() => {
    const prev = held.current;
    if (text === prev.text) return prev.epoch;
    const epoch = text.startsWith(prev.text) ? prev.epoch : prev.epoch + 1;
    held.current = { text, epoch };
    return epoch;
  }, [text]);
}

/**
 * `source` from `from` to `to`, as one text node this keeps itself: while the text is the same (`epoch`) and only grows
 * at its end, what was added is appended to the node (work for the characters added, however long the text is); any
 * other change sets the node's text once.
 */
function PlainTail({ source, from, to, epoch }) {
  const host = useRef(null);
  const held = useRef(null);
  useLayoutEffect(() => {
    const span = host.current;
    let node = span.firstChild;
    if (!node) node = span.appendChild(document.createTextNode(""));
    const h = held.current;
    if (h && h.epoch === epoch && h.from === from && to >= h.to) {
      if (to > h.to) node.appendData(source.slice(h.to, to));
    } else {
      node.data = source.slice(from, to);
    }
    held.current = { epoch, from, to };
  }, [source, from, to, epoch]);
  return <span ref={host} />;
}

/** A taken tree, shown again only when it changes (not at every frame of a reply being revealed). */
const StreamRich = memo(Rich);

/**
 * The text of a reply being written. Without `paced` every piece is shown at once; with it, a prefix of the text
 * received that grows at every frame (ui/reveal.js: `ended` — nothing more will come, the rest within a moment; `all`
 * — everything received now), with `placeholder` shown until its first characters. The tree is asked for what is shown,
 * at most every STREAM_EVERY_MS, one request at a time, and is shown at an animation frame, like every tree. A tree is
 * taken only if what is shown still is the text it was made for — unpaced, unchanged; paced, the same text grown by
 * the frames since (any other text is a stale tree, dropped). Until the next tree, what is shown after the taken one is
 * shown after it, plain. After STREAM_LATE_MAX late answers in a row the rest of the reply is plain (with the note).
 * The stored message that replaces this is rendered on its own.
 */
export function StreamingAgentText({ text, paced = false, ended = false, all = false, placeholder = null }) {
  const received = useMemo(() => withoutBidiControls(text), [text]);
  const epoch = useEpoch(received);
  const upTo = useReveal(received, epoch, { paced, ended, all });
  const shown = upTo === received.length ? received : received.slice(0, upTo);
  const client = markdownClient();
  const view = useMarkdownView();
  const host = useRef(null);
  const latest = useRef(shown);
  latest.current = shown;
  const [taken, setTaken] = useState(null);
  const [plainRest, setPlainRest] = useState(false);
  const run = useRef(null);
  run.current ??= { mounted: true, asking: false, cooling: false, again: false, late: 0, stopped: false, asked: null, timer: null, leave: null, epoch };
  run.current.epoch = epoch;

  useEffect(() => {
    const r = run.current;
    r.mounted = true;
    return () => {
      r.mounted = false;
      clearTimeout(r.timer);
      r.leave?.();
    };
  }, []);

  useEffect(() => {
    const r = run.current;
    const ask = () => {
      if (!r.mounted || r.stopped) return;
      if (r.asking || r.cooling) {
        r.again = true;
        return;
      }
      const asked = latest.current;
      if (asked === r.asked || asked === "") return;
      const askedIn = r.epoch;
      Object.assign(r, { asking: true, cooling: true, again: false, asked });
      r.timer = setTimeout(() => {
        r.cooling = false;
        if (r.again) ask();
      }, STREAM_EVERY_MS);
      loadMarkdown();
      // (Paced, what is shown grows at every frame: the same text grown is still this one.)
      const current = paced ? () => r.epoch === askedIn && latest.current.length >= asked.length : () => latest.current === asked;
      const wanted = () => r.mounted && current();
      client.request(asked, { wanted, priority: () => -1, remember: false }).then((answer) => {
        r.asking = false;
        if (!r.mounted) return;
        const late = answer !== DROPPED && answer.plain === true && answer.reason === "slow";
        if (answer === DROPPED) {
          r.asked = null;
          r.again = true;
        } else if (late) {
          r.late += 1;
          if (r.late >= STREAM_LATE_MAX) {
            r.stopped = true;
            setPlainRest(true);
            return;
          }
        } else {
          r.late = 0;
          // Taken only if what is shown is still the text it was made for (a stale tree is dropped). A tree is shown
          // at a frame; what has come by then is shown after it, plain, like everything after a taken tree.
          r.leave?.();
          r.leave = null;
          const still = paced ? () => r.epoch === askedIn : () => latest.current.startsWith(asked);
          const take = () => {
            if (r.mounted && still()) setTaken({ text: asked, result: answer, epoch: askedIn });
          };
          if (current() && answer.tree) r.leave = inFrame(answer.elements, () => view.distance(host.current), take);
          else if (current()) take();
        }
        if (r.again && !r.cooling) ask();
      });
    };
    ask();
  }, [client, view, shown, paced]);

  // (What is shown extends the taken text while it is the same text: no comparison of the texts here, at every frame.)
  const current = taken && taken.epoch === epoch && taken.text.length <= shown.length ? taken : null;
  const granted = useBudget(view, host, current?.result ?? null, 0, false);
  // A reply being revealed grows at every frame: the list keeps it in view as it grows (once per frame at most).
  const grown = useRef(upTo);
  useLayoutEffect(() => {
    if (paced && grown.current !== upTo) view.changed();
    grown.current = upTo;
  }, [view, paced, upTo]);

  let rich = null;
  let note = false;
  let from = 0;
  let kind = "plain";
  if (plainRest) {
    note = true;
    kind = "note";
  } else if (current?.result.plain) {
    note = withNote(current.result);
    kind = note ? "note" : "plain";
  } else if (current?.result.tree && granted) {
    rich = <StreamRich key="rich" tree={current.result.tree} plain={current.text} view={view} />;
    from = current.text.length;
    kind = "rich";
  }
  useShownKind(view, kind);
  const waiting = upTo === 0 && placeholder !== null;
  return (
    <div className="md-text" ref={host}>
      {waiting
        ? placeholder
        : [
            rich,
            <PlainTail key="tail" source={received} from={from} to={upTo} epoch={epoch} />,
            note ? (
              <span key="note" className="md-note">
                {SLOW_TEXT_NOTE}
              </span>
            ) : null,
          ]}
    </div>
  );
}
