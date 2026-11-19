// The one measure of memory, mirrored from the service (app/service/src/memory/weight.ts): ceil(utf-8 bytes / 3). A room's
// "too long" and "how much is left" are decided with it, so the add row refuses exactly when the service would.
// tests/memory-weight.test.js pins both sides with one shared vector.

const encoder = new TextEncoder();

export const weight = (text) => Math.ceil(encoder.encode(text).length / 3);

export const weightOf = (notes) => notes.reduce((sum, n) => sum + weight(n.text), 0);
