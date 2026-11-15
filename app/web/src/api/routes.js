// One function per service endpoint (see app/service/README.md and the route files under app/service/src).
// Paths are built here and nowhere else.
import { request, upload } from "./http.js";

const seg = (value) => encodeURIComponent(String(value));

function withQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// ───────── auth
export const register = (body) => request("POST", "/api/register", body); // {inviteCode?, email, password, displayName, handle}
export const signIn = (body) => request("POST", "/api/auth/sign-in/email", body); // {email, password, rememberMe?}
export const signOut = () => request("POST", "/api/auth/sign-out");
export const verifyEmail = (token) => request("GET", withQuery("/api/auth/verify-email", { token }));
export const requestPasswordReset = (body) => request("POST", "/api/auth/request-password-reset", body); // {email, redirectTo?}
export const resetPassword = (body) => request("POST", "/api/auth/reset-password", body); // {newPassword, token}

// ───────── me and principals
export const getMe = () => request("GET", "/api/me");
export const updateMe = (displayName) => request("PATCH", "/api/me", { displayName });
export const lookupPrincipal = (handle) => request("GET", withQuery("/api/principals/lookup", { handle }));

// ───────── social
export const getSocial = () => request("GET", "/api/social");
export const sendFriendRequest = (handle) => request("POST", "/api/friend-requests", { handle });
export const getFriendRequest = (id) => request("GET", `/api/friend-requests/${seg(id)}`);
export const acceptFriendRequest = (id) => request("POST", `/api/friend-requests/${seg(id)}/accept`);
export const rejectFriendRequest = (id) => request("POST", `/api/friend-requests/${seg(id)}/reject`);
export const withdrawFriendRequest = (id) => request("POST", `/api/friend-requests/${seg(id)}/withdraw`);
export const removeFriend = (principalId) => request("DELETE", `/api/friends/${seg(principalId)}`);
export const blockPrincipal = (principalId) => request("PUT", `/api/blocks/${seg(principalId)}`);
export const unblockPrincipal = (principalId) => request("DELETE", `/api/blocks/${seg(principalId)}`);

// ───────── conversations
export const createGroup = ({ title, memberIds }) => request("POST", "/api/conversations", { title, memberIds });
/** One conversation in the shape of a `/api/sync` entry (404 when you are not a member now). */
export const getConversation = (conversationId) => request("GET", `/api/conversations/${seg(conversationId)}`);
export const renameGroup = (conversationId, title) => request("PATCH", `/api/conversations/${seg(conversationId)}`, { title });
export const listMembers = (conversationId) => request("GET", `/api/conversations/${seg(conversationId)}/members`);
export const addMember = (conversationId, principalId) => request("POST", `/api/conversations/${seg(conversationId)}/members`, { principalId });
export const removeMember = (conversationId, principalId) =>
  request("DELETE", `/api/conversations/${seg(conversationId)}/members/${seg(principalId)}`);

// ───────── messages
/** body: {clientTxn, text?, attachmentId?, replyToSeq?}; reuse the same clientTxn when retrying. */
export const sendMessage = (conversationId, body) => request("POST", `/api/conversations/${seg(conversationId)}/messages`, body);
export const listMessages = (conversationId, { before, limit } = {}) =>
  request("GET", withQuery(`/api/conversations/${seg(conversationId)}/messages`, { before, limit }));
export const getMessage = (conversationId, seq) => request("GET", `/api/conversations/${seg(conversationId)}/messages/${seg(seq)}`);
export const markRead = (conversationId, seq) => request("POST", `/api/conversations/${seg(conversationId)}/read`, { seq });

// ───────── sync, catch-up and the socket
export const getSync = () => request("GET", "/api/sync");
/** positions: {[conversationId]: last seq held}. */
export const catchUp = (positions) => request("POST", "/api/sync/catchup", { positions });
export const requestWsTicket = () => request("POST", "/api/ws-ticket");

/** The WebSocket URL for a ticket: same origin as the page, ws: or wss: following its protocol. */
export function socketUrl(ticket) {
  const { protocol, host } = globalThis.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/ws?ticket=${seg(ticket)}`;
}

// ───────── search
export const searchConversation = (conversationId, { q, before, limit }) =>
  request("GET", withQuery(`/api/conversations/${seg(conversationId)}/search`, { q, before, limit }));
export const searchAll = ({ q, before, limit }) => request("GET", withQuery("/api/search", { q, before, limit }));

// ───────── attachment and avatar URLs (uploads and image/file bytes are not JSON, so no request() here)
export const attachmentUploadUrl = (conversationId) => `/api/conversations/${seg(conversationId)}/attachments`;
/**
 * Uploads one file (multipart field `file`) → {id, name, size, inline}; send it with `sendMessage({attachmentId, …})`.
 * options: {onProgress(fraction 0..1), signal}. Aborting rejects with ApiError code "aborted".
 */
export function uploadAttachment(conversationId, file, options) {
  const form = new FormData();
  form.append("file", file, file.name);
  return upload(attachmentUploadUrl(conversationId), form, options);
}
export const attachmentUrl = (attachmentId) => `/api/attachments/${seg(attachmentId)}`;
export const avatarUrl = (principalId) => `/api/principals/${seg(principalId)}/avatar`;
export const myAvatarUploadUrl = () => "/api/me/avatar";
