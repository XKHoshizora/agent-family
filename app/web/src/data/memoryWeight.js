// The one measure of memory, mirrored from the service (app/service/src/memory/weight.ts): ceil(utf-8 bytes / 3). A room's
// "too long" and "how much is left" are decided with it, so the add row refuses exactly when the service would.
// tests/memory-weight.test.js pins both sides with one shared vector.

const encoder = new TextEncoder();

export const weight = (text) => Math.ceil(encoder.encode(text).length / 3);

/**
 * The weight of a typed text as the service will store it: its whitespace (line breaks and runs of spaces) collapsed to single spaces and
 * trimmed, as the service's `cleanText` does first (the part of it that changes the weight of ordinary text; invisible format
 * characters are not mirrored). tests/memory-weight.test.js and the service's test share the rows.
 */
export const storedWeight = (text) => weight(text.replace(/\s+/g, " ").trim());

export const weightOf = (notes) => notes.reduce((sum, n) => sum + weight(n.text), 0);
