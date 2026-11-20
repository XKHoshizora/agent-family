// Field rules, the same as the service's (app/service/README.md, POST /api/register and the reset routes).
// Each rule returns an error text, or "" when the value is fine.

export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;
/** An Agent's name part (family names): its handle is `<owner's handle>.<name part>`. */
export const NAME_PART_PATTERN = /^[a-z0-9_]{2,24}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Format characters the service removes from display names and group names: all of them — bidi overrides and
 * isolates, zero-width spaces, the BOM, the soft hyphen… — except the joiners U+200C/U+200D and the emoji tag
 * characters, which carry meaning (emoji sequences, subdivision flags, Persian and Indic text).
 */
const STRIPPED_FORMAT = /(?![\u{200C}\u{200D}\u{E0020}-\u{E007F}])\p{Cf}/gu;
/**
 * Something visible, as the service decides it: a character that is not white space, not a control, and not one
 * that shows nothing on its own (the default-ignorable code points — format characters, joiners, variation
 * selectors, Hangul fillers… — and the Braille blank U+2800). Emoji and right-to-left text have one.
 */
const VISIBLE_CHARACTER = /[^\s\p{Cc}\p{Default_Ignorable_Code_Point}\u{2800}]/u;
/** What makes a name more than one line: control characters and the line and paragraph separators. */
const LINE_BREAKING = /[\p{Cc}\u{2028}\u{2029}]/u;

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

/** A display name as the service counts it: format characters removed (above), trimmed, one line, something visible, 1-40 code points. */
export function displayName(value) {
  if (!value.trim()) return "请输入昵称";
  const v = value.replace(STRIPPED_FORMAT, "").trim();
  if (LINE_BREAKING.test(v)) return "昵称只能是一行";
  if (!VISIBLE_CHARACTER.test(v)) return "昵称需要包含看得见的文字";
  if ([...v].length > 40) return "昵称最多 40 个字";
  return "";
}

/** An Agent's name as the service counts it: the display-name rule with 1-20 code points. */
export function agentName(value) {
  if (!value.trim()) return "请填写名称";
  const v = value.replace(STRIPPED_FORMAT, "").trim();
  if (LINE_BREAKING.test(v)) return "名称只能是一行";
  if (!VISIBLE_CHARACTER.test(v)) return "名称需要包含看得见的文字";
  if ([...v].length > 20) return "名称不超过 20 个字";
  return "";
}

export const APPELLATION_WRONG = "称呼最多 20 个字，不能换行。";

/**
 * What an Agent calls its owner or someone else, as the service takes it: trimmed, on one line, at most 20 code points. An
 * empty one is not wrong here (for the owner it means none: the caller decides what it means).
 */
export function appellation(value) {
  const v = value.trim();
  return [...v].length > 20 || LINE_BREAKING.test(v) ? APPELLATION_WRONG : "";
}

export function handle(value) {
  if (!value) return "请输入账号名";
  if (!HANDLE_PATTERN.test(value)) return "账号名为 3 到 24 位小写字母、数字或下划线";
  return "";
}

/** An Agent's name part, the part of its account name after its owner's handle and the dot. */
export function namePart(value) {
  if (!value) return "请输入账号名";
  if (!NAME_PART_PATTERN.test(value)) return "账号名为 2 到 24 位小写字母、数字或下划线";
  return "";
}

/** A group's name as the service counts it: the display-name rule with 1-60 code points. */
export function groupTitle(value) {
  if (!value.trim()) return "请输入群名称";
  const v = value.replace(STRIPPED_FORMAT, "").trim();
  if (LINE_BREAKING.test(v)) return "群名称只能是一行";
  if (!VISIBLE_CHARACTER.test(v)) return "群名称需要包含看得见的文字";
  if ([...v].length > 60) return "群名称最多 60 个字";
  return "";
}

/** Bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069): the service removes them from messages and captions. */
const BIDI_CONTROLS = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
/** Control characters other than tab, line feed and carriage return: the service refuses them in messages and captions. */
const STRAY_CONTROLS = /(?![\t\n\r])\p{Cc}/gu;

/**
 * A message's text, or a caption, as the service would take it: bidi overrides and isolates removed (the service
 * does the same), stray control characters dropped (the service would refuse them), then trimmed.
 */
export function messageText(value) {
  return value.replace(BIDI_CONTROLS, "").replace(STRAY_CONTROLS, "").trim();
}

/** Whether text shows anything: the service refuses a text message without a VISIBLE_CHARACTER. */
export function hasVisibleText(value) {
  return VISIBLE_CHARACTER.test(value);
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
