import { useCallback, useRef } from "react";
import { useStore } from "../data/store.jsx";

/** Answers that need no word: something newer replaced the request, or the session ended. */
const QUIET = ["stale", "stopped", "superseded"];

/**
 * `jumpTo(conversationId, seq)`: opens the conversation, loads the window around that message when it is not held,
 * and asks the chat to scroll to it and highlight it (`nav.focus`). A message that cannot be shown any more leaves
 * the conversation open at where it was, with a toast.
 */
export function useJumpTo() {
  const { dispatch, actions } = useStore();
  const counter = useRef(0);
  return useCallback(
    async (conversationId, seq) => {
      dispatch({ type: "nav/openConv", convId: conversationId });
      const res = await actions.jumpToMessage(conversationId, seq);
      if (res.ok) {
        counter.current += 1;
        dispatch({ type: "nav", patch: { focus: { convId: conversationId, seq, n: counter.current } } });
      } else if (!QUIET.includes(res.error?.code)) {
        dispatch({ type: "toast", text: res.error?.code === "not_found" ? "这条消息已经看不到了" : "没能打开这条消息，请稍后再试" });
      }
    },
    [dispatch, actions],
  );
}
