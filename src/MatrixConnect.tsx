import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Globe, ShieldCheck } from "lucide-react";
import { api, post } from "./api";
import { CopyButton, ErrorBox, Field, Spinner } from "./components";

export function MatrixConnect() {
  const account = useQuery({
    queryKey: ["matrix-account"],
    queryFn: () =>
      api<{
        configured: boolean;
        account: { matrixId: string } | null;
        homeserver?: string;
        elementUrl?: string;
      }>("/api/matrix/account"),
  });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/matrix/account", { password });
      setPassword("");
      await account.refetch();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (account.isPending) return <Spinner label="正在查看开放聊天服务" />;
  if (account.error) return <ErrorBox error={account.error.message} />;
  const data = account.data!;
  return (
    <section className="family-matrix">
      <div className="family-section-intro">
        <Globe size={28} />
        <div>
          <h2>与更广阔的世界连接</h2>
          <p>复用 Element 与 Synapse，和其他 Matrix 服务器上的人聊天。</p>
        </div>
      </div>
      <div className="family-notice">
        <ShieldCheck size={19} />
        <p>
          这里是独立的 Matrix 聊天入口。Agent 审批群目前在 Agent Family
          内运行；本入口的消息不会自动交给 AI。加密与设备验证由 Element 提供。
        </p>
      </div>
      {!data.configured ? (
        <p className="muted">
          开放聊天服务正在配置中。你仍可使用 Agent Family 的现有群聊。
        </p>
      ) : (
        <>
          {data.account ? (
            <div className="family-card">
              <h3>你的 Matrix 身份</h3>
              <div className="family-copy">
                <code>{data.account.matrixId}</code>
                <CopyButton text={data.account.matrixId} />
              </div>
              <p>
                在 Element
                中使用上面的完整身份和开通时设置的聊天密码登录。请保存 Element
                提供的恢复密钥。
              </p>
              <a
                className="primary-button"
                href={data.elementUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 Element 聊天 <ExternalLink size={16} />
              </a>
            </div>
          ) : (
            <form onSubmit={create} className="family-card">
              <h3>开通你的聊天身份</h3>
              <p>
                沿用你的 Agent Family 账户归属；为 Matrix 单独设置一个至少 12
                位的密码。Agent Family 不保存此密码。
              </p>
              <Field label="Matrix 聊天密码">
                <input
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <ErrorBox error={error} />
              <button className="primary-button" disabled={busy}>
                {busy ? "正在开通…" : "开通 Matrix 账户"}
              </button>
            </form>
          )}
          <p className="family-footnote">
            服务器：{data.homeserver}。首次登录后，可复制完整 Matrix
            身份给好友，在 Element 中发起一对一或群聊。
          </p>
        </>
      )}
    </section>
  );
}
