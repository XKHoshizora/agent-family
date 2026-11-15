// Humans-only reads of the social state (people, relations, blocks) the contact and group pages share.
import { ME } from "../data/identities.js";

const FROM_ME = `${ME}|`;
const TO_ME = `|${ME}`;

const withStatus = (state, status, mine) =>
  Object.entries(state.relations)
    .filter(([key, rel]) => rel.status === status && (mine ? key.startsWith(FROM_ME) : key.endsWith(TO_ME)))
    .map(([key, rel]) => ({ id: mine ? key.slice(FROM_ME.length) : key.slice(0, -TO_ME.length), ...rel }));

/** Ids of my friends, in the service's order (by account name). */
export const friendIds = (state) => withStatus(state, "established", true).map((f) => f.id);
/** Requests sent to me: {id (the sender), requestId, createdAt, expiresAt, at}. */
export const incomingRequests = (state) => withStatus(state, "incoming", false);
/** Requests I sent: {id (the recipient), requestId, createdAt, expiresAt, at}. */
export const outgoingRequests = (state) => withStatus(state, "pending", true);

/** "friend" | "incoming" | "outgoing" | null: how the person stands to me. */
export function relationOf(state, id) {
  const mine = state.relations[`${ME}|${id}`];
  if (mine) return mine.status === "established" ? "friend" : "outgoing";
  return state.relations[`${id}|${ME}`] ? "incoming" : null;
}
export const requestWith = (state, id) => state.relations[`${ME}|${id}`] ?? state.relations[`${id}|${ME}`] ?? null;

export const iBlocked = (state, id) => state.blocks.some((b) => b.by === ME && b.target === id);
export const blockedMe = (state, id) => state.blocks.some((b) => b.by === id && b.target === ME);
export const blockBetween = (state, id) => iBlocked(state, id) || blockedMe(state, id);

/** The direct conversation with a friend (it exists once you are friends), or undefined. */
export const directConvWith = (state, id) => Object.values(state.convs).find((c) => c.type === "human" && c.peerId === id);

/** My friends who can be put in a group: known by name, no block in either direction, not in `exclude`. */
export const eligibleFriends = (state, exclude = []) =>
  friendIds(state).filter((id) => state.people[id] && !blockBetween(state, id) && !exclude.includes(id));

/** Local filter by name or account name (@handle). */
export const matchesPerson = (person, query) => {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return !q || person.name.toLowerCase().includes(q) || person.handle.toLowerCase().includes(q);
};
