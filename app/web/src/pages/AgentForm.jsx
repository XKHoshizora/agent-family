import React, { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText } from "../data/errorTexts.js";
import { HANDLE_PATTERN, agentName as agentNameProblem, handle as handleProblem } from "../auth/validation.js";
import { Btn, Field, Modal, Notice, Reason, focusInvalid } from "../ui/primitives.jsx";
import { ChevronLeft, Lock } from "../icons.js";
import { AvatarEditor } from "./AvatarEditor.jsx";
import { LEVELS, ModelPicker, choiceList, modelKey, useModelSources } from "./ModelPicker.jsx";
import { useAction } from "./useAction.js";

/** The prototype's two private-reply choices, by the service's `replyMode`. */
export const REPLY_MODES = [
  ["always", "收到消息时回复"],
  ["mention", "仅在我点名时回复"],
];
/** Who may call it with @ in a group it is in, by the service's `groupMentions` (the first is the default). */
export const GROUP_MENTIONS = [
  ["members", "所有群成员"],
  ["owner", "仅我"],
];
const PERSONA_MAX = 20000;
const chars = (text) => [...text].length;

/** An action's answer (`{ok, value}` or `{ok: false, error, text}`) as a value, or the refusal thrown (for useAction). */
export async function settled(pending) {
  const result = await pending;
  if (!result.ok) throw result;
  return result.value;
}

/** The sentence of a refusal thrown by `settled` (or of anything else that went wrong). */
export const refusalText = (error) => error?.text ?? commonErrorText(error);

/** Opens an Agent's conversation, or waits for it to arrive when this client does not hold it yet. */
export function openAgentChat(state, dispatch, actions, conversationId) {
  if (!conversationId) {
    dispatch({ type: "toast", text: "会话还没有同步下来，请稍后在消息列表里查看" });
    return;
  }
  if (state.convs[conversationId]) {
    dispatch({ type: "nav/openConv", convId: conversationId });
    return;
  }
  dispatch({ type: "nav", patch: { opening: { convId: conversationId } } });
  actions.syncNow();
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const randomPart = () => Array.from({ length: 6 }, () => BASE36[Math.floor(Math.random() * 36)]).join("");

/** The account name suggested for `name`: the name itself when it makes one (spaces as "_"), else agent_ + `random`. */
export function suggestHandle(name, random) {
  const ascii = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return HANDLE_PATTERN.test(ascii) ? ascii : `agent_${random}`;
}

/** The persona as it is sent: NUL dropped (the service refuses it), trimmed (the service stores it trimmed). */
const personaOf = (text) => text.replaceAll("\u0000", "").trim();

/** The editable fields of a record (an Agent of the view model, or none), as the form holds them. */
const recordFields = (a) => ({
  name: a?.name ?? "",
  intro: a?.intro ?? "",
  field: a?.field ?? "",
  persona: a?.persona ?? "",
  replyMode: a?.replyMode ?? "always",
  groupMentions: a?.groupMentions ?? "members",
  reasoning: a?.reasoning ?? "none",
  model: modelKey(a?.model ?? null),
});

/** A field of the form as it would be stored (the text fields trimmed), to compare with the record. */
const storedValue = (key, f) => {
  if (key === "persona") return personaOf(f.persona);
  if (key === "name" || key === "intro" || key === "field") return f[key].trim();
  return f[key];
};

/**
 * Create (no `agent`) or edit one of my Agents: the prototype's form with the avatar, the account name, the model and
 * its reasoning level, and the persona (with 帮我起草) in place of the role. Refusals are shown in the form, never toasted.
 *
 * Editing sends only the fields the owner changed. While the form is open the record may change elsewhere (another
 * device, a confirmed persona proposal): a field the owner has not touched then shows the new value; a field they have
 * touched keeps their text, and a notice says that saving overwrites it.
 */
export function AgentForm({ agent = null }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const sources = useModelSources();
  const formRef = useRef(null);
  const personaId = useId();
  const [random] = useState(randomPart);
  const [f, setF] = useState(() => ({ ...recordFields(agent), handle: agent ? "" : suggestHandle("", random) }));
  const [handleTyped, setHandleTyped] = useState(false);
  const [touched, setTouched] = useState(false);
  /** The avatar picked and not sent yet (sent after the create, or with the save). */
  const [avatarFile, setAvatarFile] = useState(null);
  /** Why the avatar of the last save did not upload (the rest was saved). */
  const [avatarError, setAvatarError] = useState("");
  /** The service's refusal of the last create or save: {code, text}. */
  const [refusal, setRefusal] = useState(null);
  /** The outcome of the last 帮我起草: {done: true} or {error: text}. */
  const [draftNote, setDraftNote] = useState(null);
  const [confirmDraft, setConfirmDraft] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** The fields the owner changed (typed, chosen, drafted); only these are ever sent when editing. */
  const edited = useRef(new Set());
  /** The record's fields as this form last saw them, to tell what changed elsewhere. */
  const record = recordFields(agent);
  const recordKey = JSON.stringify(record);
  const seen = useRef(record);
  const current = useRef(f);
  current.current = f;
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const editing = agent !== null;

  // Keyed by the record's values (the view model makes a new Agent object whenever anything changes).
  useEffect(() => {
    if (!editing) return;
    const now = JSON.parse(recordKey);
    const before = seen.current;
    seen.current = now;
    const changed = Object.keys(now).filter((key) => now[key] !== before[key]);
    const theirs = changed.filter((key) => !edited.current.has(key));
    if (theirs.length > 0) {
      setF((cur) => {
        const next = { ...cur };
        for (const key of theirs) next[key] = now[key];
        return next;
      });
    }
    // A field I changed that now differs from the record (my own save brings back what I typed: no notice).
    if (changed.some((key) => edited.current.has(key) && storedValue(key, current.current) !== now[key])) setChangedElsewhere(true);
  }, [recordKey, editing]);

  const options = choiceList(sources, agent?.model ?? null, agent?.reasoning ?? "none");
  const choice = sources.status === "ready" ? options.find((o) => o.key === f.model) ?? null : null;
  const levels = choice?.levels ?? ["none"];
  const reasoning = levels.includes(f.reasoning) ? f.reasoning : "none";

  const name = f.name.trim();
  const intro = f.intro.trim();
  const field = f.field.trim();
  const persona = personaOf(f.persona);
  const errors = {
    name: agentNameProblem(f.name),
    handle: agent ? "" : handleProblem(f.handle),
    intro: chars(intro) > 40 ? "简介不超过 40 个字" : "",
    field: chars(field) > 20 ? "擅长领域不超过 20 个字" : "",
    persona: chars(persona) > PERSONA_MAX ? `人格文档不超过 ${PERSONA_MAX} 个字` : "",
  };
  const invalid = Object.values(errors).some(Boolean);
  const shown = (key) => (touched ? errors[key] : "");
  const handleError = shown("handle") || (refusal?.code === "handle_taken" ? refusal.text : "");

  const blockReason =
    sources.status === "loading"
      ? "正在读取可用的模型…"
      : choice
        ? ""
        : sources.nothing
          ? "还没有可用的模型，需要先添加模型供应商"
          : "请先选择一个模型，否则它不会回复";
  const canDraft = !errors.name && !errors.intro && !errors.field && Boolean(choice) && !choice.stale;

  const set = (key) => (event) => {
    const value = event.target.value;
    edited.current.add(key);
    setF((cur) => ({ ...cur, [key]: value }));
  };
  const setName = (event) => {
    const value = event.target.value;
    edited.current.add("name");
    setF((cur) => ({ ...cur, name: value, handle: agent || handleTyped ? cur.handle : suggestHandle(value, random) }));
  };
  const setHandle = (event) => {
    const value = event.target.value;
    setHandleTyped(true);
    setF((cur) => ({ ...cur, handle: value }));
    if (refusal?.code === "handle_taken") setRefusal(null);
  };
  const setModel = (key) => {
    const next = options.find((o) => o.key === key);
    const level = next?.levels.includes(f.reasoning) ? f.reasoning : "none";
    edited.current.add("model");
    // A level the new model does not take is reset, and that is a change of mine too.
    if (level !== f.reasoning) edited.current.add("reasoning");
    setF((cur) => ({ ...cur, model: key, reasoning: level }));
  };
  const setPersona = (event) => {
    const value = event.target.value;
    edited.current.add("persona");
    setF((cur) => ({ ...cur, persona: value }));
    // Whatever the last draft said is about text that is no longer there.
    if (draftNote) setDraftNote(null);
  };
  const pickAvatar = (file) => {
    setAvatarFile(file);
    setAvatarError("");
  };

  const back = () => dispatch({ type: "nav", patch: { agentView: "detail", pane: agent ? "main" : "list" } });
  // Editing: an avatar picked and not saved is not dropped without asking.
  const leave = () => (agent && avatarFile ? setConfirmLeave(true) : back());

  /** A refusal to show in the form (`busy_here`: another action of this form is running, nothing to say). */
  const refused = (error) => {
    if (error?.code === "busy_here") return;
    const code = error?.error?.code ?? "unknown";
    setRefusal({ code, text: refusalText(error) });
    if (code === "agent_limit") actions.loadUsage();
    if (code === "handle_taken") focusInvalid(formRef.current);
  };

  const create = async () => {
    const body = { handle: f.handle, name };
    if (intro) body.intro = intro;
    if (field) body.field = field;
    if (persona) body.persona = persona;
    body.replyMode = f.replyMode;
    body.groupMentions = f.groupMentions;
    body.reasoning = reasoning;
    body.model = choice.model;
    const res = await run(
      "save",
      async () => {
        const created = await settled(actions.createAgent(body));
        // The avatar can only be sent once the Agent exists; if it fails, the Agent stays created.
        let avatarText = null;
        if (avatarFile && created?.id) {
          const upload = await actions.uploadAgentAvatar(created.id, avatarFile);
          if (!upload.ok) avatarText = upload.text;
        }
        return { created, avatarText };
      },
      () => "",
    );
    if (!res.ok) return refused(res.error);
    const { created, avatarText } = res.value;
    if (!created?.id) {
      dispatch({ type: "nav", patch: { agentView: "detail", agentId: null, pane: "list" } });
      return;
    }
    const detail = { agentView: "detail", agentId: created.id, agentTab: "profile", pane: "main" };
    if (avatarText) {
      const text = `Agent 已创建，但头像没有上传成功：${avatarText}可以在「编辑」里重新上传。`;
      dispatch({ type: "nav", patch: { ...detail, agentNote: { agentId: created.id, text } } });
      return;
    }
    dispatch({ type: "nav", patch: detail });
    openAgentChat(state, dispatch, actions, created.conversationId);
  };

  const save = async () => {
    // Only what I changed, and only where it differs from the record as it is now: a field I did not touch is never
    // sent, so a change made elsewhere meanwhile is not overwritten by the value this form opened with.
    const mine = (key) => edited.current.has(key) && storedValue(key, f) !== record[key];
    const patch = {};
    for (const key of ["name", "intro", "field", "persona", "replyMode", "groupMentions"]) if (mine(key)) patch[key] = storedValue(key, f);
    // The service checks the model and the reasoning level together: a new model goes with its level. The level alone
    // is sent only when I changed it (a stored level the model no longer takes is not reset behind my back).
    const modelChanged = mine("model") && !choice.stale;
    if (modelChanged) patch.model = choice.model;
    if (modelChanged || (edited.current.has("reasoning") && reasoning !== record.reasoning)) patch.reasoning = reasoning;
    const changes = Object.keys(patch).length > 0;
    if (!changes && !avatarFile) {
      back();
      return;
    }
    setAvatarError("");
    const res = await run(
      "save",
      async () => {
        if (changes) await settled(actions.patchAgent(agent.id, patch));
        if (!avatarFile) return null;
        const upload = await actions.uploadAgentAvatar(agent.id, avatarFile);
        return upload.ok ? null : upload.text;
      },
      () => "",
    );
    if (!res.ok) return refused(res.error);
    if (res.value) {
      // The rest is saved (my fields now equal the record): saving again sends the avatar alone.
      setAvatarError(changes ? `其他修改已保存，但头像没有上传成功：${res.value}` : `头像没有上传成功：${res.value}`);
      return;
    }
    dispatch({ type: "nav", patch: { agentView: "detail" } });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null || blockReason) return;
    setTouched(true);
    setRefusal(null);
    if (invalid) {
      focusInvalid(event.currentTarget);
      return;
    }
    if (agent) await save();
    else await create();
  };

  const draft = async () => {
    setConfirmDraft(false);
    setDraftNote(null);
    const body = { name };
    if (intro) body.intro = intro;
    if (field) body.field = field;
    body.model = choice.model;
    const res = await run("draft", () => settled(actions.draftPersona(body)), () => "");
    if (!res.ok) {
      if (res.error?.code !== "busy_here") setDraftNote({ error: refusalText(res.error) });
      return;
    }
    if (typeof res.value?.persona !== "string") {
      setDraftNote({ error: commonErrorText(null) });
      return;
    }
    edited.current.add("persona");
    setF((cur) => ({ ...cur, persona: res.value.persona }));
    setDraftNote({ done: true });
  };
  // Drafting never replaces what was written without asking.
  const askDraft = () => (f.persona.trim() ? setConfirmDraft(true) : draft());

  const personaError = shown("persona");
  const describedBy = [`${personaId}-count`, personaError && `${personaId}-error`, draftNote?.error && `${personaId}-draft`, `${personaId}-hint`]
    .filter(Boolean)
    .join(" ");
  const limitText =
    refusal?.code === "agent_limit" && Number.isFinite(state.usage?.agentLimit)
      ? `你的 Agent 数量已达到当前档位的上限（最多 ${state.usage.agentLimit} 个）。删除不用的 Agent 后可以再创建。`
      : refusal?.text;

  return (
    <section className="page" aria-label={agent ? "编辑 Agent" : "创建 Agent"}>
      <button type="button" className="back" onClick={leave}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回
      </button>
      <header className="profile-head">
        <div>
          <p className="eyebrow">我的 Agent</p>
          <h2>{agent ? `编辑 ${agent.name}` : "创建 Agent"}</h2>
        </div>
      </header>
      <form ref={formRef} className="page-body form" onSubmit={submit} noValidate>
        {changedElsewhere && <Notice tone="warn">这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。</Notice>}
        <div className="field">
          <span className="field-label">头像</span>
          {/* Held until the form is saved (after the Agent is created, or with the other changes). */}
          <AvatarEditor
            id={agent ? agent.id : null}
            onPick={pickAvatar}
            disabled={busy !== null}
            hint={agent ? "支持 PNG、JPEG、WebP，不超过 2 MB；保存后生效。" : undefined}
          />
          {avatarError && <p className="field-msg" role="alert">{avatarError}</p>}
        </div>
        <Field label="名称" error={shown("name")}>
          <input value={f.name} onChange={setName} autoComplete="off" placeholder="例如：我的美食助手" />
        </Field>
        {agent ? (
          <div className="field">
            <span className="field-label">账号名</span>
            <p className="readonly"><Lock size={14} aria-hidden="true" /> {agent.handle}（创建后不可修改）</p>
          </div>
        ) : (
          <Field label="账号名" hint="3 到 24 位小写字母、数字或下划线，创建后不可修改" error={handleError}>
            <input value={f.handle} onChange={setHandle} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
        )}
        <div className="field">
          <span className="field-label">主人</span>
          <p className="readonly"><Lock size={14} aria-hidden="true" /> 你（不可修改）</p>
        </div>
        <Field label="简介" error={shown("intro")}>
          <input value={f.intro} onChange={set("intro")} autoComplete="off" placeholder="一句话介绍它能做什么" />
        </Field>
        <Field label="擅长领域" error={shown("field")}>
          <input value={f.field} onChange={set("field")} autoComplete="off" placeholder="例如：旅行规划" />
        </Field>
        <ModelPicker sources={sources} options={options} value={f.model} onChange={setModel} />
        {choice && levels.length > 1 && (
          <Field label="思考程度" hint="思考越多，回复越慢，用量也越多。">
            <select value={reasoning} onChange={set("reasoning")}>
              {LEVELS.filter(([id]) => levels.includes(id)).map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </Field>
        )}
        <div className={`field ${personaError ? "field-error" : ""}`}>
          <label htmlFor={personaId}>人格文档</label>
          <textarea
            id={personaId}
            rows={10}
            value={f.persona}
            onChange={setPersona}
            readOnly={busy === "draft"}
            aria-invalid={personaError ? true : undefined}
            aria-describedby={describedBy}
          />
          <div className="member-actions">
            <Btn small disabled={!canDraft || busy !== null} reason="填写名称并选择模型后可以让它起草" onClick={askDraft}>
              {busy === "draft" ? "起草中…" : "帮我起草"}
            </Btn>
            <span id={`${personaId}-count`} className="field-hint">{chars(persona)} / {PERSONA_MAX}</span>
          </div>
          {personaError && <p id={`${personaId}-error`} className="field-msg" role="alert">{personaError}</p>}
          {draftNote?.error && <p id={`${personaId}-draft`} className="field-msg" role="alert">{draftNote.error}</p>}
          {draftNote?.done && <p className="field-hint" role="status">{agent ? "已填入起草的内容，保存后才会生效。" : "已填入起草的内容，创建后才会生效。"}</p>}
          <p id={`${personaId}-hint`} className="field-hint">
            决定它是谁、怎么说话、擅长什么。只影响它如何回复，不授予任何权限。{!canDraft && "填写名称并选择模型后，可以让它帮你起草。"}留空时，它会先在会话里问你几个问题。
          </p>
        </div>
        <Field label="私聊回复方式" hint="“点名”就是在消息里 @ 它。">
          <select value={f.replyMode} onChange={set("replyMode")}>
            {REPLY_MODES.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="群里谁可以叫它" hint="被叫到时它会在群里回复，费用算你的。">
          <select value={f.groupMentions} onChange={set("groupMentions")}>
            {GROUP_MENTIONS.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </Field>
        <Notice tone="info">
          {agent ? "修改从它的下一次回复起生效。" : "创建后会生成一个你和它的专属会话。它没有工具、文件或电脑权限，只在这个会话里回复你。"}
        </Notice>
        {refusal && refusal.code !== "handle_taken" && <Notice tone="warn">{limitText}</Notice>}
        <div className="form-actions">
          <Reason>{blockReason}</Reason>
          <Btn onClick={leave}>取消</Btn>
          <Btn variant="primary" type="submit" disabled={Boolean(blockReason) || busy !== null} reason={blockReason}>
            {busy === "save" ? (agent ? "保存中…" : "创建中…") : agent ? "保存" : "创建 Agent"}
          </Btn>
        </div>
      </form>
      {confirmDraft && (
        <Modal
          title="替换已写的人格文档？"
          onClose={() => setConfirmDraft(false)}
          footer={
            <>
              <Btn data-autofocus onClick={() => setConfirmDraft(false)}>取消</Btn>
              <Btn variant="primary" onClick={draft}>起草并替换</Btn>
            </>
          }
        >
          <p>起草的内容会替换人格文档里现有的文字。</p>
        </Modal>
      )}
      {confirmLeave && (
        <Modal
          title="放弃新头像？"
          onClose={() => setConfirmLeave(false)}
          footer={
            <>
              <Btn data-autofocus onClick={() => setConfirmLeave(false)}>继续编辑</Btn>
              <Btn variant="danger" onClick={back}>放弃</Btn>
            </>
          }
        >
          <p>头像还没有保存，确定放弃吗？</p>
        </Modal>
      )}
    </section>
  );
}
