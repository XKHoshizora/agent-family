// The service's error codes (app/service/README.md) as Chinese texts, and which form field a code belongs to.

const MESSAGES = {
  invalid_email_or_password: "邮箱或密码不对，请再试一次。",
  email_not_verified: "这个邮箱还没有验证。我们刚刚又发了一封验证邮件，请查收后再登录。",
  invalid_invite: "邀请码无效或已过期，请向邀请你的人确认。",
  handle_taken: "这个账号名已被占用，换一个试试。",
  rate_limited: "操作太频繁了，请稍等一分钟再试。",
  invalid_token: "链接无效或已过期，请重新申请。",
  invalid_email: "邮箱格式不正确",
  password_too_short: "密码至少 10 位",
  password_too_long: "密码最多 128 位",
  invalid_request: "填写的内容有误，请检查后再试。",
  network_error: "连不上服务，请检查网络后重试。",
  busy: "服务现在有点忙，请稍后再试。",
};

export const FALLBACK_MESSAGE = "出了点问题，请稍后再试。";

export const messageFor = (code) => MESSAGES[code] ?? FALLBACK_MESSAGE;

const FIELDS = {
  invalid_invite: "inviteCode",
  handle_taken: "handle",
  invalid_email: "email",
  password_too_short: "password",
  password_too_long: "password",
};

/** The form field a code is about, or null when it belongs to the form as a whole. */
export const fieldOf = (code) => FIELDS[code] ?? null;

const VERIFY_MESSAGES = {
  TOKEN_EXPIRED: "验证链接已过期。请直接登录，我们会重新发送一封验证邮件。",
};
export const VERIFY_FALLBACK = "验证链接无效或已被使用。如果还没验证，请直接登录，我们会重新发送一封验证邮件。";

export const verifyMessage = (code) => VERIFY_MESSAGES[code] ?? VERIFY_FALLBACK;
