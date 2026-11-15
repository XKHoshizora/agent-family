// Shared identity constants. People and Agents come from the service (state.people / state.agents).
// Avatar cells are [column, row] in the 3x3 atlas at public/assets/identities.png.
export const ME = "me";

export const BRAND_CELL = [2, 2];
// Newly created Agents have no dedicated artwork in the atlas; they use the brand mark.
export const DEFAULT_AGENT_CELL = [2, 2];
