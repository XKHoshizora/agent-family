// Agent Family extension using Element's public Module API. Native room UI is retained.
const R = window.React;
const h = R.createElement;
const state = R.useState;
function Button({ children, onClick, disabled = false, secondary = false }) {
  return h(
    "button",
    {
      type: "button",
      onClick,
      disabled,
      className: secondary ? "af-button af-secondary" : "af-button",
    },
    children,
  );
}
export default class AgentFamilyModule {
  static moduleApiVersion = "^2.3.0";
  constructor(api) {
    this.api = api;
  }
  async load() {
    const api = this.api;
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = "/af-module.css";
    document.head.append(style);
    const request = async (path, body, method) => {
      const userId = api.profile.value?.userId;
      const res = await fetch("/api/social" + path, {
        method: method || (body ? "POST" : "GET"),
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "x-af-matrix-id": userId || "",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "暂时无法连接，请稍后重试。");
      return data;
    };
    function Shell({ title, children }) {
      return h(
        "main",
        { className: "af-page" },
        h(
          "div",
          { className: "af-page-heading" },
          h(
            "div",
            null,
            h("p", { className: "af-eyebrow" }, "AGENT FAMILY"),
            h("h1", null, title),
          ),
          h("a", { href: "#/home" }, "返回聊天"),
        ),
        children,
      );
    }
    function usePanel(load) {
      const [data, setData] = state(null),
        [error, setError] = state(""),
        [busy, setBusy] = state(false);
      const refresh = async () => {
        try {
          setData(await load());
          setError("");
        } catch (e) {
          setError(e.message);
        }
      };
      R.useEffect(() => {
        let active = true;
        const update = async () => {
          try {
            const next = await load();
            if (active) {
              setData(next);
            }
          } catch (e) {
            if (active) setError(e.message);
          }
        };
        void update();
        const timer = setInterval(update, 15000);
        return () => {
          active = false;
          clearInterval(timer);
        };
      }, []);
      const act = async (fn) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await fn();
          await refresh();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };
      return { data, error, busy, act };
    }
    function ErrorNotice({ text }) {
      return text
        ? h(
            "div",
            { className: "af-error", role: "alert" },
            text,
            " ",
            /登录|账号.*不一致/.test(text)
              ? h("a", { href: "/af-login.html" }, "恢复统一登录")
              : null,
          )
        : null;
    }
    const toPerson = (p) =>
      api.navigation.toMatrixToLink(
        `https://matrix.to/#/${encodeURIComponent(p.matrixId)}`,
      );
    let ignoredWatch, ignoredOwner;
    const observeIgnored = () => {};
    function ignoredData() {
      const current = api.profile.value?.userId;
      if (!ignoredWatch || current !== ignoredOwner) {
        ignoredWatch?.unwatch(observeIgnored);
        ignoredWatch = api.client.accountData.get("m.ignored_user_list");
        ignoredWatch.watch(observeIgnored);
        ignoredOwner = current;
      }
      return ignoredWatch.value || {};
    }
    async function ignore(person, enabled) {
      // Matrix's ignored-user list is the upstream client-side mute mechanism.
      // AF separately blocks friend requests; this does not claim to remove shared-group history.
      const old = ignoredData();
      const users = { ...(old.ignored_users || {}) };
      if (enabled) users[person.matrixId] = {};
      else delete users[person.matrixId];
      if (enabled)
        await request("/blocks", { targetId: person.id, enabled: true });
      try {
        await api.client.accountData.set("m.ignored_user_list", {
          ...old,
          ignored_users: users,
        });
        if (!enabled)
          await request("/blocks", { targetId: person.id, enabled: false });
      } catch {
        if (!enabled)
          await api.client.accountData
            .set("m.ignored_user_list", old)
            .catch(() => {});
        throw new Error(
          enabled
            ? "已阻止好友申请，但消息忽略尚未同步；请保持本页打开，系统会重试。"
            : "解除拉黑尚未完成，请重试。",
        );
      }
    }
    async function contactsData() {
      let friends = await request("/friends");
      const native = ignoredData(),
        ignored = native.ignored_users || {};
      // Native Ignore also hides incoming AF requests. AF blocks remain until explicitly removed here.
      let changed = false;
      for (const relation of friends.relations) {
        if (ignored[relation.person.matrixId]) {
          await request("/blocks", {
            targetId: relation.person.id,
            enabled: true,
          });
          changed = true;
        }
      }
      if (changed) friends = await request("/friends");
      const merged = { ...ignored };
      let needsSync = false;
      for (const person of friends.blocked) {
        if (!merged[person.matrixId]) {
          merged[person.matrixId] = {};
          needsSync = true;
        }
      }
      if (needsSync)
        await api.client.accountData.set("m.ignored_user_list", {
          ...native,
          ignored_users: merged,
        });
      return { ...friends, me: await request("/me") };
    }
    function Contacts() {
      const { data, error, busy, act } = usePanel(contactsData);
      const [query, setQuery] = state(""),
        [found, setFound] = state(undefined),
        [note, setNote] = state("");
      const relations = data?.relations || [],
        accepted = relations.filter((r) => r.status === "accepted"),
        pending = relations.filter((r) => r.status === "pending");
      const card = (p, buttons, extra) =>
        h(
          "article",
          { className: "af-card", key: p.id },
          h("div", { className: "af-avatar" }, p.name.slice(0, 1)),
          h(
            "div",
            { className: "af-card-body" },
            h("strong", null, p.name),
            h("code", null, p.matrixId),
            extra,
          ),
          h("div", { className: "af-actions" }, buttons),
        );
      return h(
        Shell,
        { title: "联系人" },
        h(
          "p",
          { className: "af-lead" },
          "互相确认，成为好友。聊天邀请和 Agent 的执行授权分别管理。",
        ),
        h(ErrorNotice, { text: error }),
        data?.me &&
          h(
            "div",
            { className: "af-id" },
            "我的聊天 ID ",
            h("code", null, data.me.person.matrixId),
            h(
              Button,
              {
                secondary: true,
                onClick: () =>
                  navigator.clipboard.writeText(data.me.person.matrixId),
              },
              "复制",
            ),
          ),
        h(
          "section",
          { className: "af-section" },
          h("h2", null, "添加朋友"),
          h(
            "form",
            {
              className: "af-search",
              onSubmit: (e) => {
                e.preventDefault();
                void act(async () =>
                  setFound(
                    (
                      await request(
                        "/people?matrixId=" + encodeURIComponent(query.trim()),
                      )
                    ).person,
                  ),
                );
              },
            },
            h("input", {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: "输入完整聊天 ID，例如 @名字:服务器",
              required: true,
              "aria-label": "朋友的聊天 ID",
            }),
            h(
              "button",
              { className: "af-button", disabled: busy, type: "submit" },
              "查找",
            ),
          ),
          found === null &&
            h(
              "p",
              null,
              "未找到本站账号。外部 Matrix 用户可以通过原生聊天邀请互通；外部好友申请互通仍待接入。",
              h(
                Button,
                {
                  secondary: true,
                  onClick: () => toPerson({ matrixId: query.trim() }),
                },
                "打开 Matrix 用户",
              ),
            ),
          found &&
            card(
              found,
              h(
                Button,
                {
                  disabled: busy,
                  onClick: () =>
                    act(async () => {
                      await request("/friends", { targetId: found.id, note });
                      setFound(undefined);
                      setNote("");
                    }),
                },
                "发送好友申请",
              ),
              h("input", {
                value: note,
                onChange: (e) => setNote(e.target.value),
                maxLength: 200,
                placeholder: "打个招呼（可选）",
                "aria-label": "申请留言",
              }),
            ),
        ),
        h(
          "section",
          { className: "af-section" },
          h("h2", null, `新朋友 · ${pending.length}`),
          !pending.length &&
            h("p", { className: "af-muted" }, "暂无待处理的申请。"),
          ...pending.map((r) =>
            card(
              r.person,
              h(
                R.Fragment,
                null,
                r.incoming
                  ? h(
                      R.Fragment,
                      null,
                      h(
                        Button,
                        {
                          disabled: busy,
                          onClick: () =>
                            act(() => request(`/friends/${r.id}/accept`, {})),
                        },
                        "接受",
                      ),
                      h(
                        Button,
                        {
                          disabled: busy,
                          secondary: true,
                          onClick: () =>
                            act(() => request(`/friends/${r.id}/reject`, {})),
                        },
                        "拒绝",
                      ),
                      h(
                        Button,
                        {
                          secondary: true,
                          disabled: busy,
                          onClick: () => act(() => ignore(r.person, true)),
                        },
                        "拉黑",
                      ),
                    )
                  : h(
                      Button,
                      {
                        disabled: busy,
                        secondary: true,
                        onClick: () =>
                          act(() => request(`/friends/${r.id}/cancel`, {})),
                      },
                      "撤回",
                    ),
              ),
              h(
                "p",
                null,
                (r.incoming ? "申请加你为好友" : "等待对方确认") +
                  (r.note ? " · " + r.note : ""),
              ),
            ),
          ),
        ),
        h(
          "section",
          { className: "af-section" },
          h("h2", null, `好友 · ${accepted.length}`),
          !accepted.length &&
            h(
              "p",
              { className: "af-muted" },
              "输入朋友的聊天 ID，发送第一条申请。",
            ),
          ...accepted.map((r) =>
            card(
              r.person,
              h(
                R.Fragment,
                null,
                h(Button, { onClick: () => toPerson(r.person) }, "发消息"),
                h(
                  Button,
                  {
                    secondary: true,
                    disabled: busy,
                    onClick: () => {
                      if (
                        confirm(
                          "删除好友关系？聊天记录仍保留，重新成为好友需要再次申请。",
                        )
                      )
                        void act(() => request(`/friends/${r.id}/remove`, {}));
                    },
                  },
                  "删除",
                ),
                h(
                  Button,
                  {
                    secondary: true,
                    disabled: busy,
                    onClick: () => {
                      if (
                        confirm(
                          "拉黑会移除好友关系、阻止新的好友申请，并在当前 Matrix 账号中忽略对方消息。已有记录不会删除，共同群组不会自动解散。",
                        )
                      )
                        void act(() => ignore(r.person, true));
                    },
                  },
                  "拉黑",
                ),
              ),
            ),
          ),
        ),
        h(
          "details",
          { className: "af-section" },
          h("summary", null, `已拉黑 · ${data?.blocked?.length || 0}`),
          ...(data?.blocked || []).map((p) =>
            card(
              p,
              h(
                Button,
                {
                  secondary: true,
                  disabled: busy,
                  onClick: () => act(() => ignore(p, false)),
                },
                "解除拉黑",
              ),
            ),
          ),
        ),
        h(
          "p",
          { className: "af-muted" },
          "解除拉黑不会自动恢复好友关系。好友列表不等于群成员或工具授权列表。",
        ),
      );
    }
    function Agents() {
      const { data, error, busy, act } = usePanel(async () => ({
        ...(await request("/agents")),
        me: await request("/me"),
      }));
      const [editing, setEditing] = state(null),
        [name, setName] = state(""),
        [persona, setPersona] = state(""),
        [model, setModel] = state("");
      const models =
        editing && editing !== "new"
          ? data?.agents.find((a) => a.id === editing)?.models || []
          : data?.me?.models || [];
      const choose = (a) => {
        const defaults = data?.me?.models || [];
        setEditing(a?.id || "new");
        setName(a?.name || "");
        setPersona(a?.persona || "");
        setModel(
          a
            ? JSON.stringify([a.provider, a.model])
            : defaults[0]
              ? JSON.stringify([defaults[0].provider, defaults[0].id])
              : "",
        );
      };
      const save = (e) => {
        e.preventDefault();
        void act(async () => {
          const [provider, modelId] = JSON.parse(model);
          await request(
            "/agents" + (editing === "new" ? "" : "/" + editing),
            { name, persona, provider, model: modelId },
            editing === "new" ? "POST" : "PATCH",
          );
          setEditing(null);
        });
      };
      return h(
        Shell,
        { title: "我的 Agent" },
        h(
          "p",
          { className: "af-lead" },
          "每个 Agent 都有独立身份。在原生加密聊天里交流，由你决定是否运行。",
        ),
        h(ErrorNotice, { text: error }),
        h(
          "div",
          { className: "af-toolbar" },
          h(
            Button,
            {
              disabled: busy || !models.length || !data?.me?.canManage,
              onClick: () => choose(null),
            },
            "创建 Agent",
          ),
          h(
            "span",
            { className: "af-muted" },
            "默认无电脑、无工具权限 · 每个 Agent 每日最多回复 20 次",
          ),
        ),
        data &&
          !models.length &&
          h(
            "p",
            { className: "af-error" },
            "当前账号尚未配置可用模型，请联系管理员。",
          ),
        editing &&
          h(
            "form",
            { className: "af-editor", onSubmit: save },
            h("h2", null, editing === "new" ? "创建 Agent" : "编辑 Agent"),
            h(
              "label",
              null,
              "名称",
              h("input", {
                value: name,
                onChange: (e) => setName(e.target.value),
                required: true,
                maxLength: 40,
              }),
            ),
            h(
              "label",
              null,
              "职责和表达方式",
              h("textarea", {
                value: persona,
                onChange: (e) => setPersona(e.target.value),
                maxLength: 4000,
                rows: 4,
                placeholder: "例如：帮助我整理想法，回答简洁，先确认事实。",
              }),
            ),
            h(
              "label",
              null,
              "模型",
              h(
                "select",
                {
                  value: model,
                  onChange: (e) => setModel(e.target.value),
                  required: true,
                },
                ...models.map((m) =>
                  h(
                    "option",
                    {
                      key: m.provider + "/" + m.id,
                      value: JSON.stringify([m.provider, m.id]),
                    },
                    m.label,
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "af-actions" },
              h(
                "button",
                { type: "submit", className: "af-button", disabled: busy },
                busy ? "正在保存…" : "保存",
              ),
              h(
                Button,
                { secondary: true, onClick: () => setEditing(null) },
                "取消",
              ),
            ),
          ),
        h(
          "div",
          { className: "af-agent-grid" },
          ...(data?.agents || []).map((a) =>
            h(
              "article",
              { className: "af-agent-card", key: a.id },
              h(
                "div",
                { className: "af-agent-top" },
                h("div", { className: "af-avatar" }, a.name.slice(0, 1)),
                h(
                  "span",
                  { className: "af-badge" },
                  a.status === "active"
                    ? "已启用"
                    : a.status === "paused"
                      ? "已暂停"
                      : a.status === "provisioning"
                        ? "接入中"
                        : "接入异常",
                ),
              ),
              h("h2", null, a.name),
              h("p", null, a.persona || "尚未设置职责"),
              h("code", null, a.matrixId),
              h("p", { className: "af-muted" }, a.model),
              h(
                "div",
                { className: "af-actions" },
                h(
                  Button,
                  {
                    disabled: busy || !["active", "paused"].includes(a.status),
                    onClick: () =>
                      act(async () => {
                        const r = await request(`/agents/${a.id}/chat`, {});
                        api.navigation.openRoom(r.roomId, { autoJoin: true });
                      }),
                  },
                  "聊天",
                ),
                h(
                  Button,
                  { secondary: true, disabled: busy, onClick: () => choose(a) },
                  "编辑",
                ),
                h(
                  Button,
                  {
                    secondary: true,
                    disabled: busy || a.status === "provisioning",
                    onClick: () =>
                      act(() =>
                        request(
                          `/agents/${a.id}`,
                          { paused: a.status === "active" },
                          "PATCH",
                        ),
                      ),
                  },
                  a.status === "error"
                    ? "重试接入"
                    : a.status === "paused"
                      ? "恢复"
                      : "暂停",
                ),
              ),
            ),
          ),
        ),
        data &&
          !data.agents.length &&
          h(
            "div",
            { className: "af-empty" },
            h("h2", null, "让第一位 Agent 加入聊天"),
            h("p", null, "设置名称、职责和模型，然后点击“聊天”。"),
          ),
        h(
          "aside",
          { className: "af-note" },
          h("strong", null, "本批次：主人与自己的 Agent 私聊"),
          h(
            "p",
            null,
            "房间仅允许主人与该 Agent。主人未加入、Agent 被暂停或成员不符合要求时不回复；离线和暂停期间的消息不会自动补跑。当前只处理文字，不读取附件或操作电脑。",
          ),
          h(
            "p",
            null,
            "跨主人 Agent 群仍在整体方案内，需要完成全部主人可见、扩员与恢复验收后接入；本页面不会把普通群邀请当作运行授权。",
          ),
        ),
      );
    }
    api.navigation.registerLocationRenderer("af-contacts", () => h(Contacts));
    api.navigation.registerLocationRenderer("af-agents", () => h(Agents));
    api.extras.setSpacePanelItem("af-contacts", {
      label: "联系人",
      tooltip: "联系人与好友申请",
      icon: h("span", { className: "af-nav-icon" }, "友"),
      onSelected: () => {
        location.hash = "/af-contacts";
      },
    });
    api.extras.setSpacePanelItem("af-agents", {
      label: "我的 Agent",
      tooltip: "创建和管理我的 Agent",
      icon: h("span", { className: "af-nav-icon" }, "AI"),
      onSelected: () => {
        location.hash = "/af-agents";
      },
    });
    // Activate the profile watch so API requests see the current Matrix identity.
    // Native logout redirects to af-logout.html, which waits for AF sign-out.
    api.profile.watch(() => {});
    // Native Element SSO records its homeserver and flow before redirecting.
    // Reuse that flow (config.sso_redirect_options); a hand-built SSO link loses it.
  }
}
