/** How long each mailed link works; Better Auth's `expiresIn` settings (auth.ts) and the mail text both read these. */
export const VERIFY_EMAIL_TTL_SECONDS = 24 * 60 * 60;
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

export interface MailCopy {
  subject: string;
  body: string;
}

const IGNORE_LINE = "如果这不是你本人的操作，请忽略这封邮件。";

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
