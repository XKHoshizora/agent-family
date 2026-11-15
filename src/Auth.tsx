import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ShieldCheck, UsersRound } from "lucide-react";
import { api, post, setWorkspace } from "./api";
import { Logo, Field, ErrorBox, Spinner } from "./components";
export function Auth({
  setup,
  invite,
}: {
  setup: boolean;
  invite: string | null;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(false);
  const info = useQuery({
    queryKey: ["invite", invite],
    queryFn: () => api(`/api/invites/${invite}`),
    enabled: !!invite,
  });
  const register = setup || (!!invite && !existing);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setup)
        await post("/api/setup", {
          name,
          email,
          password,
          ...(token ? { token } : {}),
        });
      if (invite && !existing) {
        const result = await post("/api/invites/accept", {
          token: invite,
          name,
          email,
          password,
        });
        setWorkspace(result.workspaceId);
      }
      await post("/api/auth/sign-in/email", { email, password });
      if (invite && existing) {
        const result = await post("/api/invites/accept", { token: invite });
        setWorkspace(result.workspaceId);
      }
      if (invite) history.replaceState(null, "", location.pathname);
      await client.invalidateQueries();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <Logo />
        <div className="auth-illustration">
          <div className="orbit-circle one" />
          <div className="orbit-circle two" />
          <div className="orbit-circle three" />
          <span className="orbit-letter a">智</span>
          <span className="orbit-letter b">文</span>
          <span className="orbit-letter c">研</span>
        </div>
        <h1>
          一个问题，
          <br />
          不止一种好答案。
        </h1>
        <p>
          让不同 AI 伙伴坐到一起。
          <br />
          分享灵感，比较观点，一起把事情做好。
        </p>
        <div className="auth-foot">
          <span>GPT</span>
          <i />
          <span>Claude</span>
          <i />
          <span>Gemini</span>
        </div>
      </div>
      <div className="auth-form-wrap">
        <div className="auth-mobile-logo">
          <Logo />
        </div>
        <form onSubmit={submit} className="auth-form">
          <h2>
            {setup
              ? "欢迎来到 Agent Family"
              : invite
                ? "加入你的团队"
                : "登录实验工作台"}
          </h2>
          <p className="muted">
            {setup
              ? "创建第一个账户，开启你的专属 AI 群聊。"
              : invite
                ? `你受邀加入「${info.data?.name || "工作空间"}」。`
                : "管理模型与已有讨论。工作台账户与聊天账户暂时独立。"}
          </p>
          <ErrorBox error={error || info.error?.message} />
          {register && (
            <Field label="怎么称呼你">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="你的名字"
                maxLength={40}
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="邮箱">
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
            />
          </Field>
          <Field
            label="密码"
            hint={register ? "至少 10 位，建议包含不同字符。" : undefined}
          >
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={register ? 10 : 1}
              maxLength={128}
              autoComplete={register ? "new-password" : "current-password"}
              placeholder={register ? "设置一个安全的密码" : "输入密码"}
            />
          </Field>
          {setup && (
            <details>
              <summary>远程部署初始化</summary>
              <Field
                label="初始化码"
                hint="本机使用无需填写。远程首次设置请查阅部署说明。"
              >
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  type="password"
                />
              </Field>
            </details>
          )}
          <button
            className="button primary full"
            disabled={busy || !!info.error}
          >
            {busy ? (
              <Spinner label="正在进入" />
            ) : (
              <>
                {register ? "创建账户并进入" : "登录"}
                <ArrowRight size={18} />
              </>
            )}
          </button>
          {invite && (
            <button
              type="button"
              className="text-button full"
              onClick={() => setExisting(!existing)}
            >
              {existing ? "还没有账户？创建一个" : "已有账户？登录后加入"}
            </button>
          )}
          <div className="auth-note">
            <ShieldCheck size={17} />
            <span>
              {setup
                ? "默认仅受邀成员可加入。模型密钥只保存在服务端。"
                : "内部邀请测试中。没有账户？请联系空间管理员。"}
            </span>
          </div>
          {!setup && !invite && (
            <div className="hint">
              忘记密码时，请联系部署管理员按照账户恢复说明重置。
            </div>
          )}
        </form>
        <div className="auth-bottom">
          <UsersRound size={15} /> 多个伙伴 · 同一个对话
        </div>
      </div>
    </div>
  );
}
