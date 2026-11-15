// Shared identity constants. People and Agents come from the service (state.people / state.agents).
// Avatar cells are [column, row] in the 3x3 atlas at public/assets/identities.png.
export const ME = "me";

export const BRAND_CELL = [2, 2];
// Newly created Agents have no dedicated artwork in the atlas; they use the brand mark.
export const DEFAULT_AGENT_CELL = [2, 2];

// Placeholder faces for people until real avatars are shown (Task 9): mine, and the others' by id, so the
// same person always gets the same face (also one who left and is no longer named here).
export const MY_CELL = [0, 0];
const PERSON_CELLS = [
  [1, 0],
  [2, 0],
];
export function personCell(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSON_CELLS[h % PERSON_CELLS.length];
}
