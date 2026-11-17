// Why a file could not be sent, in the words the timeline and the toasts use. Input: {code, reason, status}
// as `ApiError`s and the unsent entries carry them.

/** The most a file may weigh, as people read it (the limit itself is `MAX_FILE_BYTES` in actions.js). */
export const FILE_LIMIT_TEXT = "1 GB";

export function failureText(error) {
  const code = error?.code;
  if (code === "too_large" && error?.reason === "quota") return "你的附件空间已用完，无法再发送文件";
  // A proxy in front of the service may refuse a big body with its own plain 413.
  if (code === "too_large" || error?.status === 413) return `文件超过 ${FILE_LIMIT_TEXT}，无法发送`;
  switch (code) {
    case "rate_limited":
      return "上传太频繁，请稍后再试";
    case "cannot_send":
      return "当前无法在这个会话发送新消息";
    case "not_found":
      return "这个会话已不可用";
    case "network_error":
      return "网络连接失败，请检查网络后重试";
    case "stale":
      return "会话状态已变化，请重新发送";
    default:
      return "文件未能发送，请稍后重试";
  }
}

/** A retry would be refused the same way: the file itself is the problem. */
export const retryHopeless = (error) => error?.code === "too_large" || error?.status === 413;
