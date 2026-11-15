const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

const PALETTE = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#475569"];

/** Generated avatar: one letter on a colour derived from the id. Text is escaped; colours come from a fixed palette. */
export function defaultAvatarSvg(displayName: string, principalId: string): string {
  const first = Array.from(displayName.trim())[0] ?? "?";
  const initial = escapeXml(first.toUpperCase());
  let h = 0;
  for (const ch of principalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const fill = PALETTE[h % PALETTE.length]!;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">` +
    `<rect width="128" height="128" fill="${fill}"/>` +
    `<text x="64" y="64" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="64" fill="#ffffff">${initial}</text>` +
    `</svg>`
  );
}
