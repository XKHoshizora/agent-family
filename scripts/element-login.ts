import { createAuthClient } from "better-auth/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
const auth = createAuthClient({
  baseURL: location.origin,
  plugins: [oauthProviderClient()],
});
const form = document.querySelector<HTMLFormElement>("#login")!;
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button")!,
    error = document.querySelector("#error")!;
  button.disabled = true;
  error.textContent = "";
  try {
    const data = new FormData(form);
    const result = await auth.signIn.email({
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (result.error)
      throw new Error(result.error.message || "登录未完成，请检查账号和密码。");
    // The official OAuth client/plugin handles a signed authorization continuation.
    // With no pending OAuth request, return to native SSO: session cookie avoids a second password prompt.
    if (!result.data?.redirect) location.assign("/");
  } catch (e) {
    error.textContent =
      e instanceof Error ? e.message : "登录未完成，请稍后重试。";
  } finally {
    button.disabled = false;
  }
});
