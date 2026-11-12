export let workspaceId = localStorage.getItem("af-workspace") || "";
export function setWorkspace(value: string) {
  workspaceId = value;
  localStorage.setItem("af-workspace", value);
}
export async function api<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(30000),
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...options.headers,
    },
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (
      response.status === 401 &&
      !url.startsWith("/api/auth/") &&
      url !== "/api/me"
    )
      window.dispatchEvent(new Event("af-auth-expired"));
    const translations: Record<string, string> = {
      INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确。",
      USER_ALREADY_EXISTS: "这个邮箱已注册，请改用登录。",
      USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "这个邮箱已注册，请改用登录。",
      INVALID_PASSWORD: "当前密码不正确。",
      PASSWORD_TOO_SHORT: "密码至少需要 10 位。",
    };
    throw Object.assign(
      new Error(
        translations[body.code] ||
          (response.status === 429
            ? "操作太频繁，请稍等片刻再试。"
            : undefined) ||
          body.error?.message ||
          body.error ||
          body.message ||
          "操作未完成，请稍后重试。",
      ),
      { status: response.status },
    );
  }
  return body;
}
export const post = <T = any>(url: string, body: unknown = {}) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });
export const patch = <T = any>(url: string, body: unknown) =>
  api<T>(url, { method: "PATCH", body: JSON.stringify(body) });
export async function copy(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}
export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
