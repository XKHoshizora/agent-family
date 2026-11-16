// Field rules, the same as the service's (app/service/README.md, POST /api/register and the reset routes).
// Each rule returns an error text, or "" when the value is fine.

export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(value) {
  const v = value.trim();
  if (!v) return "请输入邮箱";
  if (v.length > 254 || !EMAIL_PATTERN.test(v)) return "邮箱格式不正确";
  return "";
}

/** Sign-in: only that something was typed; the service decides whether it is right. */
export function currentPassword(value) {
  return value ? "" : "请输入密码";
}

/** A password being chosen: 10-128 characters. */
export function newPassword(value) {
  if (value.length < 10) return "密码至少 10 位";
  if (value.length > 128) return "密码最多 128 位";
  return "";
}

export function inviteCode(value) {
  const v = value.trim();
  if (!v) return "请输入邀请码";
  if (v.length > 100) return "邀请码太长了";
  return "";
}

export function displayName(value) {
  // As the service counts it: one line, 1-40 code points once format characters are removed and the ends trimmed.
  if (/[\r\n]/.test(value.trim())) return "昵称只能是一行";
  const v = value.replace(/\p{Cf}/gu, "").trim();
  if (!v) return "请输入昵称";
  if ([...v].length > 40) return "昵称最多 40 个字";
  return "";
}

export function handle(value) {
  if (!value) return "请输入账号名";
  if (!HANDLE_PATTERN.test(value)) return "账号名为 3 到 24 位小写字母、数字或下划线";
  return "";
}

/**
 * Format characters the service removes from group names (as from display names): all of them — bidi overrides
 * and isolates, zero-width spaces, the BOM, the soft hyphen… — except the joiners U+200C/U+200D and the emoji tag
 * characters, which carry meaning (emoji sequences, subdivision flags, Persian and Indic text).
 */
const STRIPPED_FORMAT = /(?![\u200C\u200D\u{E0020}-\u{E007F}])\p{Cf}/gu;
/** Something visible: anything but the joiners and tag characters, which only change what is next to them. */
const BASE_CHARACTER = /[^\u200C\u200D\u{E0020}-\u{E007F}]/u;

/**
 * A group's name as the service counts it: format characters removed (above), trimmed, something visible in it,
 * one line, 1-60 code points.
 */
export function groupTitle(value) {
  if (!value.trim()) return "请输入群名称";
  const v = value.replace(STRIPPED_FORMAT, "").trim();
  if (!BASE_CHARACTER.test(v)) return "群名称需要包含看得见的文字";
  if (/[\p{Cc}\u2028\u2029]/u.test(v)) return "群名称只能是一行";
  if ([...v].length > 60) return "群名称最多 60 个字";
  return "";
}

/** Bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069): the service removes them from messages and captions. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** A message's text, or a caption, as the service stores it: bidi overrides and isolates removed, then trimmed. */
export function messageText(value) {
  return value.replace(BIDI_CONTROLS, "").trim();
}

/** Whether text shows anything: the service refuses a text message with no character that is neither white space nor a format character. */
export function hasVisibleText(value) {
  return /[^\s\p{Cf}]/u.test(value);
}

/** @returns {Record<string,string>} the failing fields only, in the order of `rules` */
export function validate(values, rules) {
  const errors = {};
  for (const [name, rule] of Object.entries(rules)) {
    const message = rule(values[name] ?? "");
    if (message) errors[name] = message;
  }
  return errors;
}
