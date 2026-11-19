import React, { useEffect, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { profileErrorText } from "../data/errorTexts.js";
import { displayName as displayNameProblem } from "../auth/validation.js";
import { entity, nameOf } from "../state/selectors.js";
import { Avatar, Btn, Field, KV, Reason, Switch, Tag } from "../ui/primitives.jsx";
import { ListHeader } from "./ChatList.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { AvatarEditor } from "./AvatarEditor.jsx";
import { ProvidersPage } from "./Providers.jsx";
import { UsagePage } from "./Usage.jsx";
import { ChevronLeft } from "../icons.js";
import { useSession } from "../auth/AuthRoot.jsx";
import { MemoryRoom, useMemoryRoom } from "./MemoryRoom.jsx";
import { MEMORY_LANGUAGES, languageName } from "../data/memoryLanguages.js";
import { ModelGroups, choiceList, modelKey, useModelSources } from "./ModelPicker.jsx";
import { refusalText, settled, useAction } from "./useAction.js";

export function SettingsList() {
  const { state, dispatch } = useStore();
  const self = entity(state, ME) || { name: "", handle: "" };
  const open = (patch) => dispatch({ type: "nav", patch: { pane: "main", ...patch } });
  return (
    <>
      <ListHeader title="设置" />
      <div className="settings-me">
        <Avatar id={ME} size={56} online />
        <div>
          <strong>{state.account?.displayName ?? ""}</strong>
          <p className="muted">{self.handle} · 真人账户</p>
        </div>
      </div>
      <ul className="rows">
        <li className="rows-label">快捷入口</li>
        <li>
          <button type="button" className="row slim" onClick={() => open({ settingsPage: "profile" })}>
            <span className="row-body"><span className="row-name">我的资料</span><span className="row-preview">昵称、头像与账户</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => open({ settingsPage: "providers" })}>
            <span className="row-body"><span className="row-name">模型供应商</span><span className="row-preview">你自己的模型服务账号与密钥</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => open({ settingsPage: "usage" })}>
            <span className="row-body"><span className="row-name">用量与余额</span><span className="row-preview">今日免费额度、余额与最近用量</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => open({ settingsPage: "memory" })}>
            <span className="row-body"><span className="row-name">记忆宫殿</span><span className="row-preview">记住的关于你的事，可以在这里整理</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => open({ settingsPage: "blocks" })}>
            <span className="row-body"><span className="row-name">拉黑</span><span className="row-preview">你拉黑的人，可在这里解除</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => dispatch({ type: "nav", patch: { section: "contacts", pane: "list" } })}>
            <span className="row-body"><span className="row-name">通讯录与申请</span><span className="row-preview">好友、待处理的申请</span></span>
          </button>
        </li>
      </ul>
    </>
  );
}

function BackButton() {
  const { dispatch } = useStore();
  return (
    <button type="button" className="back only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}>
      <ChevronLeft size={20} aria-hidden="true" /> 返回
    </button>
  );
}

function NameForm({ account }) {
  const { dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const [name, setName] = useState(account.displayName);
  const [error, setError] = useState("");
  useEffect(() => setName(account.displayName), [account.displayName]);
  const unchanged = name.trim() === account.displayName;

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null || unchanged) return;
    const problem = displayNameProblem(name);
    setError(problem);
    if (problem) return;
    const res = await run("name", () => actions.updateDisplayName(name.trim()), (e) => profileErrorText("name", e));
    if (res.ok) dispatch({ type: "toast", text: "昵称已更新" });
  };

  return (
    <form onSubmit={submit}>
      <Field label="昵称" error={error} hint="1–40 个字，只能一行。其他人会在下次同步时看到新昵称。">
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <Btn type="submit" variant="primary" disabled={busy !== null || unchanged}>
        {busy === "name" ? "保存中…" : "保存"}
      </Btn>
    </form>
  );
}

function ProfilePage() {
  const { state, dispatch, actions } = useStore();
  const session = useSession();
  // (Before the first load there is no account yet: the page shows what the people table knows.)
  const self = entity(state, ME);
  const account = state.account ?? { displayName: self?.displayName ?? "", handle: String(self?.handle ?? "").replace(/^@/, ""), email: "" };
  const signOut = async () => {
    const result = await session.signOut();
    if (!result.ok) dispatch({ type: "toast", text: "退出登录失败，请检查网络后重试" });
  };
  return (
    <section className="page" aria-label="设置">
      <BackButton />
      <header className="profile-head">
        <div>
          <p className="eyebrow">我的资料</p>
          <h2>{account.displayName} <Tag tone="human">真人</Tag></h2>
          <p className="muted">@{account.handle}</p>
        </div>
      </header>
      <div className="page-body">
        <h3>头像</h3>
        <AvatarEditor upload={actions.uploadAvatar} errorText={(e) => profileErrorText("avatar", e)} />
        <h3>昵称</h3>
        <NameForm account={account} />
        <h3>账户</h3>
        <KV rows={[["账号名", `@${account.handle}`], ["邮箱", account.email ?? ""]]} />
        <p className="muted">账号名和邮箱不能修改。</p>
        {session && (
          <div className="stack-actions row-actions">
            <Btn variant="danger" onClick={signOut}>退出登录</Btn>
          </div>
        )}
      </div>
    </section>
  );
}

/** The people I blocked, each with a way to lift it (confirmed first, as everywhere). */
function BlockedPage() {
  const { state } = useStore();
  const [target, setTarget] = useState(null);
  const mine = state.blocks.filter((b) => b.by === ME);
  return (
    <section className="page" aria-label="拉黑">
      <BackButton />
      <header className="profile-head">
        <div>
          <p className="eyebrow">拉黑</p>
          <h2>我的拉黑</h2>
          <p className="muted">拉黑后，你们之间不能发送新消息，也不能互相申请好友；只有你可以解除自己的拉黑。</p>
        </div>
      </header>
      <div className="page-body">
        {mine.length === 0 ? (
          <p className="muted">你没有拉黑任何人。</p>
        ) : (
          <ul className="member-rows" aria-label="我拉黑的人">
            {mine.map((b) => (
              <li key={b.target}>
                <Avatar id={b.target} size={40} />
                <div className="member-body">
                  <strong>{nameOf(state, b.target)}</strong>
                  <p className="muted">{state.people[b.target]?.handle ?? ""}</p>
                </div>
                <div className="member-actions">
                  <Btn small onClick={() => setTarget(b.target)}>解除拉黑</Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {target && <BlockModal target={target} onClose={() => setTarget(null)} />}
    </section>
  );
}

const NEW_NOTES = [
  ["auto", "自动判断要不要进保险箱"],
  ["vault", "全部进保险箱"],
  ["open", "全部不进保险箱"],
];

/**
 * My memory settings, read once (`GET /api/me`): 作息 (the switch 入梦 and 记忆用的语言, with the question about converting the notes
 * already there), 新记下的内容 (where a note goes when it is written, the vault or not) and
 * 用哪个模型整理记忆 (the model that tidies it). Each box shows what the service holds; a change is shown once it is saved,
 * a refusal is toasted and the box stays as it was. `settings`: null while being read, "" when it could not be (every control
 * stay off and say so).
 */
function MemorySettings() {
  const { actions } = useStore();
  const { busy, run } = useAction();
  const sources = useModelSources();
  const [settings, setSettings] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // The language just chosen, while I am asked whether to convert the notes already there; and how the conversion went.
  const [asked, setAsked] = useState(null);
  const [converted, setConverted] = useState(null);
  useEffect(() => {
    let alive = true;
    actions.loadMemorySettings().then((res) => {
      if (alive) setSettings(res.ok ? res.value : "");
    });
    return () => {
      alive = false;
    };
  }, [actions, attempt]);
  const retry = () => {
    setSettings(null);
    setAttempt((n) => n + 1);
  };
  const off = !settings || busy !== null;
  const unread = <option value="" hidden>{settings === null ? "正在读取…" : "读取失败"}</option>;

  const changeDream = async (event) => {
    const res = await run("dream", () => settled(actions.setDream(event.target.checked)), refusalText);
    if (res.ok) setSettings((cur) => ({ ...cur, dream: res.value }));
  };

  const changeLanguage = async (event) => {
    const next = event.target.value === "auto" ? null : event.target.value;
    const res = await run("memoryLanguage", () => settled(actions.setMemoryLanguage(next)), refusalText);
    if (!res.ok) return;
    setSettings((cur) => ({ ...cur, memoryLanguage: res.value }));
    setConverted(null);
    setAsked(res.value);
  };

  const convertNotes = async () => {
    const res = await run("convert", () => settled(actions.convertMemoryLanguage()), refusalText);
    if (!res.ok) return;
    setConverted(res.value);
    setAsked(null);
  };

  const changeNewNotes = async (event) => {
    const res = await run("newNotes", () => settled(actions.setNewNotes(event.target.value)), refusalText);
    if (res.ok) setSettings((cur) => ({ ...cur, newNotes: res.value }));
  };

  // The chosen model leads the list when it is no longer offered, as it does on the Agent form.
  const options = settings ? choiceList(sources, settings.memoryModel) : [];
  const changeModel = async (event) => {
    const next = options.find((o) => o.key === event.target.value)?.model ?? null;
    const res = await run("memoryModel", () => settled(actions.setMemoryModel(next)), refusalText);
    if (!res.ok) return;
    // Whether it can be used is the service's to say (its key may be unset or unreadable): read the settings again; when
    // that fails, what was saved is shown and the warning waits for the next read.
    const again = await actions.loadMemorySettings();
    setSettings((cur) => (again.ok ? again.value : { ...cur, memoryModel: res.value }));
  };
  return (
    <>
      <section aria-label="作息">
        <h3>作息</h3>
        <p>
          <strong>小憩</strong>
        </p>
        <p className="field-hint">聊完一段后，它会回想刚才的对话，记下值得留的事。</p>
        <fieldset className="memory-switches" disabled={off}>
          <Switch
            checked={settings?.dream === true}
            onChange={changeDream}
            label="入梦"
            hint="你休息的时候，它把这一天记下的整理一遍：合并重复的，分清一时的情绪和长久的事。"
            hintClass="field-hint"
          />
        </fieldset>
        <Field label="记忆用的语言" hint="它记下的笔记统一用这种语言写；名字和原话保留原文。">
          <select value={settings ? (settings.memoryLanguage ?? "auto") : ""} disabled={off} onChange={changeLanguage}>
            {!settings && unread}
            <option value="auto">自动</option>
            {MEMORY_LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </Field>
        {busy === "convert" ? (
          <p className="field-hint" role="status">正在转换…</p>
        ) : converted ? (
          <p className="field-hint" role="status">转了 {converted.converted} 条，{converted.kept} 条保持原样。</p>
        ) : asked ? (
          <p className="field-hint">
            <span>把已有的笔记也转成{languageName(asked)}吗？</span>{" "}
            <Btn small disabled={off} onClick={convertNotes}>转换</Btn> <Btn small disabled={off} onClick={() => setAsked(null)}>先不用</Btn>
          </p>
        ) : null}
      </section>
      <Field label="新记下的内容" hint="只管以后新记下的；已经记下的不会因此移动。">
        <select value={settings?.newNotes ?? ""} disabled={off} onChange={changeNewNotes}>
          {!settings && unread}
          {NEW_NOTES.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </Field>
      <Field label="用哪个模型整理记忆" hint="换成自己的模型后，记得好不好我们没法保证；安全检查不变。">
        <select value={settings ? modelKey(settings.memoryModel) : ""} disabled={off || sources.status !== "ready"} onChange={changeModel}>
          {!settings && unread}
          <option value="">站点的模型（已校准）</option>
          {options.filter((o) => o.stale).map((o) => (
            <option key={`current-${o.key}`} value={o.key}>{o.label}</option>
          ))}
          <ModelGroups sources={sources} />
        </select>
      </Field>
      {settings && !settings.memoryModelUsable && <Reason>选的模型现在用不了，记忆暂时不会更新。</Reason>}
      {settings === "" && (
        <Reason>
          没能读取这项设置，请重试。 <Btn small onClick={retry}>重试</Btn>
        </Reason>
      )}
    </>
  );
}

/** 记忆宫殿: how new notes are sorted, and the room 关于我 (shared by all my Agents). */
function MemoryPage() {
  const memory = useMemoryRoom(null);
  const { room, failure } = memory;
  return (
    <section className="page" aria-label="记忆宫殿">
      <BackButton />
      <header className="profile-head">
        <div>
          <h2>记忆宫殿</h2>
          <p className="muted">Agent 记住的事都在这里，可以随时整理。</p>
        </div>
      </header>
      <div className="page-body">
        <MemorySettings />
        {room ? (
          <MemoryRoom title="关于我" helper="你名下的所有 Agent 共用这一份。" memory={memory} />
        ) : failure ? (
          <p className="field-msg" role="alert">{failure}</p>
        ) : (
          <p className="muted">正在读取…</p>
        )}
      </div>
    </section>
  );
}

/** The settings page `nav.settingsPage` names: "profile" (the default), "providers", "usage", "memory" or "blocks". */
export function SettingsMain() {
  const { state } = useStore();
  switch (state.nav.settingsPage) {
    case "blocks":
      return <BlockedPage />;
    case "providers":
      return <ProvidersPage back={<BackButton />} />;
    case "usage":
      return <UsagePage back={<BackButton />} />;
    case "memory":
      return <MemoryPage />;
    default:
      return <ProfilePage />;
  }
}
