/** Models sometimes imitate our history envelope. Only unwrap a complete,
 * self-attributed envelope; never adopt its status, tools or routing metadata. */
export function unwrapOwnAnswer(text: string, author: string, model: string) {
  if (!text.trim().startsWith("{")) return text;
  try {
    const value = JSON.parse(text);
    if (
      value?.kind === "AI伙伴发言" &&
      value.author === author &&
      value.model === model &&
      typeof value.content === "string"
    )
      return value.content;
  } catch {
    /* Streaming or legitimate non-JSON text stays untouched. */
  }
  return text;
}
