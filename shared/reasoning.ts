/** Separate explicitly tagged reasoning only; never infer unreturned thoughts. */
export function splitReasoning(text: string, streaming = false) {
  let content = "",
    reasoning = "";
  let index = 0,
    thinkingTag = "",
    fence = "",
    inlineTicks = 0;
  const lower = text.toLowerCase();
  const openingTags = ["<think>", "<thinking>"];
  while (index < text.length) {
    const rest = text.slice(index);
    if (thinkingTag) {
      const closing = `</${thinkingTag}>`;
      const end = lower.indexOf(closing, index);
      if (end !== -1) {
        reasoning += text.slice(index, end);
        thinkingTag = "";
        index = end + closing.length;
        continue;
      }
      // Hold an incomplete closing delimiter while the next chunk arrives.
      let endOfThought = text.length;
      for (let size = 1; size < closing.length && size <= rest.length; size++) {
        if (lower.endsWith(closing.slice(0, size)))
          endOfThought = text.length - size;
      }
      reasoning += text.slice(index, endOfThought);
      break;
    }
    if (!"<`~".includes(text[index])) {
      content += text[index++];
      continue;
    }
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const atLineStart = /^\s*$/.test(text.slice(lineStart, index));
    const ticks = rest.match(/^(`+|~{3,})/)?.[0];
    if (ticks) {
      if (atLineStart && ticks.length >= 3 && !inlineTicks) {
        if (!fence) fence = ticks;
        else if (ticks[0] === fence[0] && ticks.length >= fence.length)
          fence = "";
      } else if (!fence && ticks[0] === "`") {
        if (!inlineTicks) inlineTicks = ticks.length;
        else if (ticks.length === inlineTicks) inlineTicks = 0;
      }
      content += ticks;
      index += ticks.length;
      continue;
    }
    if (!fence && !inlineTicks && atLineStart) {
      const opening = openingTags.find((tag) => lower.startsWith(tag, index));
      if (opening) {
        if (reasoning.trim()) reasoning += "\n\n";
        thinkingTag = opening.slice(1, -1);
        index += opening.length;
        continue;
      }
      if (
        streaming &&
        rest.length < 10 &&
        openingTags.some((tag) => tag.startsWith(rest.toLowerCase()))
      )
        break;
    }
    content += text[index++];
  }
  return { content: content.trim(), reasoning: reasoning.trim() };
}
