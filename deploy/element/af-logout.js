async function logout() {
  document.querySelector("#retry").hidden = true;
  try {
    const r = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    if (!r.ok) throw new Error();
    document.querySelector("h1").textContent = "已退出账号";
    document.querySelector("#status").textContent =
      "聊天与 Agent Family 登录均已退出。";
    document.querySelector("#login").hidden = false;
  } catch {
    document.querySelector("#status").textContent =
      "聊天已退出，但账号会话尚未结束，请点击重试。";
    document.querySelector("#retry").hidden = false;
  }
}
document.querySelector("#retry").addEventListener("click", logout);
void logout();
