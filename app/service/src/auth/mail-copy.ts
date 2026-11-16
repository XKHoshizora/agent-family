/** How long each mailed link works; Better Auth's `expiresIn` settings (auth.ts) and the mail text both read these. */
export const VERIFY_EMAIL_TTL_SECONDS = 24 * 60 * 60;
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

export interface MailCopy {
  subject: string;
  body: string;
}

const IGNORE_LINE = "如果这不是你本人的操作，请忽略这封邮件。";
/**
 * The verification mail's version of IGNORE_LINE: someone may register an address that is not theirs, and following
 * the link would confirm that account (and the password they chose) as the address owner's.
 */
const NOT_REGISTERED_LINE = "如果你没有注册 Agent Family，请不要点击链接，直接忽略这封邮件。";

/** "24 小时", "1 小时", "30 分钟": the lifetime in the unit people say it in. */
function validFor(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function verifyEmailMail(url: string): MailCopy {
  return {
    subject: "验证你的 Agent Family 邮箱",
    body: [
      "你好，",
      "欢迎来到 Agent Family。请点击下面的链接，确认这个邮箱属于你：",
      url,
      `链接 ${validFor(VERIFY_EMAIL_TTL_SECONDS)}内有效。`,
      NOT_REGISTERED_LINE,
    ].join("\n"),
  };
}

/** To the owner of a verified account, when someone tries to register its address again (nothing was changed). */
export function registrationAttemptMail(signInLink: string, resetLink: string): MailCopy {
  return {
    subject: "有人尝试用你的邮箱注册 Agent Family",
    body: [
      "你好，",
      "刚刚有人尝试用这个邮箱注册 Agent Family。这个邮箱已经有账号了，所以没有创建新账号，你的账号也没有任何变化。",
      "如果是你本人，请直接登录：",
      signInLink,
      "如果忘记了密码，可以在这里重置：",
      resetLink,
      IGNORE_LINE,
    ].join("\n"),
  };
}

export function resetPasswordMail(link: string): MailCopy {
  return {
    subject: "重置你的 Agent Family 密码",
    body: [
      "你好，",
      "我们收到了重置你 Agent Family 账号密码的请求。请点击下面的链接设置新密码：",
      link,
      `链接 ${validFor(RESET_PASSWORD_TTL_SECONDS)}内有效，且只能使用一次。`,
      IGNORE_LINE,
    ].join("\n"),
  };
}
