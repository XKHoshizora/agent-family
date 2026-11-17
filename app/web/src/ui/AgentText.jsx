// An Agent's text in its bubble, stored or being written. It is shown as plain text at once (as a person's message is),
// and as Markdown once the Markdown worker's tree for it has come back and been checked (markdownClient.js): no
// spinner, nothing moves but the change from plain to rich. Nothing here parses, typesets or highlights. Shown plain:
// while the tree is coming; for a text not near the visible part of its conversation, or pushed out of the
// conversation's element budget (markdownView.jsx); with a note, for a text too complex or too slow to render; without
// one, where there is no worker. Bidirectional controls are taken out of the text before it is shown either way.
import React, { Suspense, memo, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChunkBoundary } from "./ChunkBoundary.jsx";
import { DROPPED, markdownClient, withNote } from "./markdownClient.js";
import { withoutBidiControls } from "./markdownRules.js";
import { useMarkdownView } from "./markdownView.jsx";
import { PlainWithNote } from "./slowTexts.jsx";

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
 */
function useBudget(view, host, result, epoch) {
  const [granted, setGranted] = useState(false);
  useLayoutEffect(() => {
    if (!result?.tree) {
      setGranted(false);
      return undefined;
    }
    const ticket = view.claim(host.current, result.rendered, () => setGranted(false));
    setGranted(ticket.granted);
    return () => ticket.release();
  }, [view, host, result, epoch]);
  return granted;
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

/**
 * The text of an Agent's stored message. `id`: the message's (where the browser cannot tell what is near, the newest
 * Agent texts are). Asked for once near; once rich it stays rich while shown (unless the budget pushes it back).
 */
export const AgentText = memo(function AgentText({ text, id = null }) {
  const shown = useMemo(() => withoutBidiControls(text), [text]);
  const client = markdownClient();
  const view = useMarkdownView();
  const host = useRef(null);
  const { near, epoch } = useNear(view, host, id);
  const [held, setHeld] = useState(() => ({ text: shown, result: client.peek(shown) }));
  const result = held.text === shown ? held.result : null;

  useEffect(() => {
    if (result) return undefined;
    const now = client.peek(shown);
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

  const granted = useBudget(view, host, result, epoch);
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
 * The text of a reply being written. Every piece is shown at once; the tree is asked for at most every
 * STREAM_EVERY_MS, one request at a time, and a tree is taken only if the text has not changed while it was made (a
 * stale one is dropped). Until the next tree, the text that came after the taken one is shown after it, plain. After
 * STREAM_LATE_MAX late answers in a row the rest of the reply is plain (with the note). The stored message that
 * replaces this is rendered on its own.
 */
export function StreamingAgentText({ text }) {
  const shown = useMemo(() => withoutBidiControls(text), [text]);
  const client = markdownClient();
  const view = useMarkdownView();
  const host = useRef(null);
  const latest = useRef(shown);
  latest.current = shown;
  const [taken, setTaken] = useState(null);
  const [plainRest, setPlainRest] = useState(false);
  const run = useRef(null);
  run.current ??= { mounted: true, asking: false, cooling: false, again: false, late: 0, stopped: false, asked: null, timer: null };

  useEffect(() => {
    const r = run.current;
    r.mounted = true;
    return () => {
      r.mounted = false;
      clearTimeout(r.timer);
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
      if (asked === r.asked) return;
      Object.assign(r, { asking: true, cooling: true, again: false, asked });
      r.timer = setTimeout(() => {
        r.cooling = false;
        if (r.again) ask();
      }, STREAM_EVERY_MS);
      loadMarkdown();
      const wanted = () => r.mounted && latest.current === asked;
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
          // Taken only if the text is still the one it was made for (a stale tree is dropped).
          if (latest.current === asked) setTaken({ text: asked, result: answer });
        }
        if (r.again && !r.cooling) ask();
      });
    };
    ask();
  }, [client, shown]);

  const current = taken && shown.startsWith(taken.text) ? taken : null;
  const granted = useBudget(view, host, current?.result ?? null, 0);
  let body = shown;
  let kind = "plain";
  if (plainRest) {
    body = <PlainWithNote text={shown} />;
    kind = "note";
  } else if (current?.result.plain) {
    body = plainOf(shown, current.result);
    kind = withNote(current.result) ? "note" : "plain";
  } else if (current?.result.tree && granted) {
    body = (
      <>
        <Rich tree={current.result.tree} plain={current.text} view={view} />
        {shown.slice(current.text.length)}
      </>
    );
    kind = "rich";
  }
  useShownKind(view, kind);
  return (
    <div className="md-text" ref={host}>
      {body}
    </div>
  );
}
