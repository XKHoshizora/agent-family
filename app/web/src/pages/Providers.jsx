import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { Btn, Field, Modal, Notice, Reason, focusInvalid } from "../ui/primitives.jsx";
import { ChevronLeft, Lock, Plus } from "../icons.js";
import { useAction } from "./useAction.js";
import { refusalText, settled } from "./AgentForm.jsx";

/** The four interface types (the service's `protocol`), by the names people know them by. Fixed once created. */
export const PROTOCOLS = [
  ["openai_chat", "OpenAI Chat Completions"],
  ["openai_responses", "OpenAI Responses"],
  ["anthropic", "Anthropic Messages"],
  ["gemini", "Gemini API"],
];
export const protocolLabel = (protocol) => PROTOCOLS.find(([id]) => id === protocol)?.[1] ?? protocol;
/** The vendors' own addresses for each type (app/service/README.md, "Calling a model"): the address field's example. */
const EXAMPLE_ADDRESS = {
  openai_chat: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

// The service's limits (app/service/README.md, "Model providers").
const MAX_PROVIDERS = 10;
const MAX_MODELS = 100;
const CONTEXT_MIN = 1000;
const CONTEXT_MAX = 2000000;

/** Spec §6.8: what is said wherever a model source is chosen or added. */
const PRIVACY_TEXT = "选用这个供应商模型的 Agent，你与它的对话内容，包括发给它的图片和文件，会发送给这个供应商。";
/** The service never sends a saved key to another origin than the one it was saved for. */
const KEY_AGAIN = "接口地址换了域名，需要重新填写密钥。";
const KEY_CLEARED = "为了安全，刚才填写的密钥已经清空，请重新填写。";

const chars = (text) => [...text].length;
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** What the service refuses in a one-line name: control characters, line breaks included. */
const CONTROL = /\p{Cc}/u;

function nameProblem(text) {
  const name = text.trim();
  if (!name) return "请填写名称";
  if (CONTROL.test(name)) return "名称只能是一行";
  if (chars(name) > 40) return "名称不超过 40 个字";
  return "";
}

function modelNameProblem(name, models) {
  if (!name) return "请填写模型名称";
  if (CONTROL.test(name)) return "模型名称只能是一行";
  if (chars(name) > 100) return "模型名称不超过 100 个字";
  if (models.some((m) => m.name === name)) return "列表里已经有这个模型了";
  if (models.length >= MAX_MODELS) return `最多 ${MAX_MODELS} 个模型`;
  return "";
}

function addressProblem(text) {
  const value = text.trim();
  if (!value) return "请填写接口地址";
  if (chars(value) > 1000) return "接口地址不超过 1000 个字符";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "接口地址的格式不对，例如 https://api.openai.com/v1";
  }
  if (url.protocol !== "https:") return "接口地址需要以 https:// 开头";
  if (url.username || url.password) return "接口地址里不能包含用户名或密码";
  return "";
}

/** The service's rule for a key, after trimming: 8–1000 printable ASCII characters, no spaces. */
const keyFormatProblem = (value) => (/^[\x21-\x7e]{8,1000}$/.test(value.trim()) ? "" : "密钥需要是 8 到 1000 个字符，只能有英文字母、数字和符号，不能有空格。");

/** Scheme, host and port, as the service compares them; null when the address does not parse. */
function originOf(address) {
  try {
    return new URL(address.trim()).origin;
  } catch {
    return null;
  }
}

/** A context as typed ("128,000" is fine): the number, or null when it is empty or not one. */
const contextNumber = (text) => {
  const digits = text.replace(/[\s,_]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
};
const contextProblem = (text) => {
  if (!text.trim()) return "";
  const n = contextNumber(text);
  return n !== null && n >= CONTEXT_MIN && n <= CONTEXT_MAX ? "" : `上下文容量需要是 ${CONTEXT_MIN} 到 ${CONTEXT_MAX} 之间的整数`;
};

/** A model of the provider as the form holds it: the context as text ("" means the service's default). */
const formModel = (m) => ({
  name: m.name,
  vision: Boolean(m.vision),
  pdf: Boolean(m.pdf),
  reasoning: Boolean(m.reasoning),
  context: Number.isFinite(m.contextTokens) ? String(m.contextTokens) : "",
});
/** As it is sent: the flags always, the context only when one is given. */
const wireModel = (m) => {
  const n = contextNumber(m.context);
  return { name: m.name, vision: m.vision, pdf: m.pdf, reasoning: m.reasoning, ...(n === null ? {} : { contextTokens: n }) };
};
const modelsKey = (list) => JSON.stringify(list.map((m) => [m.name, m.vision, m.pdf, m.reasoning, m.contextTokens ?? null]));

/** The outcome of 测试连接: success, a 404/405 (no model list: said plainly, not as an error) or the sentence for the error. */
function TestResult({ result }) {
  if (!result) return null;
  if (result.ok) return <p className="field-hint" role="status">连接成功，供应商正常回应。</p>;
  const noList = result.error?.code === "provider_unavailable" && (result.error.upstreamStatus === "404" || result.error.upstreamStatus === "405");
  return noList ? (
    <p className="field-hint" role="status">{result.text}</p>
  ) : (
    <p className="field-msg" role="alert">{result.text}</p>
  );
}

/** 测试连接 of a saved provider (its saved address and key), through the caller's `run` so it waits for the other actions. */
function useConnectionTest(providerId, run) {
  const { actions } = useStore();
  const [result, setResult] = useState(null);
  const test = async () => {
    setResult(null);
    const res = await run("test", () => settled(actions.testProvider(providerId)), () => "");
    if (res.ok) setResult({ ok: true });
    else if (res.error?.code !== "busy_here") setResult({ ok: false, error: res.error?.error ?? null, text: refusalText(res.error) });
  };
  return { result, test };
}

function ProviderRow({ provider, onEdit, onDelete }) {
  const { busy, run } = useAction();
  const { result, test } = useConnectionTest(provider.id, run);
  const count = provider.models.length;
  return (
    <li>
      <div className="member-body">
        <strong>{provider.name}</strong>
        <p>
          {protocolLabel(provider.protocol)} · {provider.baseUrl}
        </p>
        <p>
          密钥 …{provider.keyLast4} · {count > 0 ? `${count} 个模型` : "还没有模型"}
        </p>
        <TestResult result={result} />
      </div>
      <div className="member-actions">
        <Btn small disabled={busy !== null} onClick={test}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </Btn>
        <Btn small onClick={onEdit}>编辑</Btn>
        <Btn small variant="danger" onClick={onDelete}>删除</Btn>
      </div>
    </li>
  );
}

function DeleteModal({ provider, onClose }) {
  const { actions, dispatch } = useStore();
  const { busy, run } = useAction();
  /** The last refusal: {code, agents, text}. */
  const [refusal, setRefusal] = useState(null);
  const confirm = async () => {
    setRefusal(null);
    const res = await run("delete", () => settled(actions.deleteProvider(provider.id)), () => "");
    if (res.ok) {
      dispatch({ type: "toast", text: `已删除「${provider.name}」` });
      onClose();
      return;
    }
    if (res.error?.code === "busy_here") return;
    const error = res.error?.error ?? {};
    setRefusal({ code: error.code, agents: Array.isArray(error.agents) ? error.agents : [], text: refusalText(res.error) });
  };
  const inUse = refusal?.code === "provider_in_use" && refusal.agents.length > 0;
  return (
    <Modal
      title={`删除「${provider.name}」`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "删除中…" : "确认删除"}
          </Btn>
        </>
      }
    >
      <p>删除后，它保存的密钥和模型列表会一起删除，不可恢复。</p>
      {inUse ? (
        <Notice tone="warn">
          还有 Agent 在使用这个供应商，请先给它们换一个模型，再删除：
          <ul className="plain-list" aria-label="正在使用它的 Agent">
            {refusal.agents.map((a) => (
              <li key={a.id}>{a.name}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        refusal && <Notice tone="warn">{refusal.text}</Notice>
      )}
    </Modal>
  );
}

/** One model of the form: what it can do, its context, and the 高级 disclosure to change them. */
function ModelRow({ model, open, error, defaults, onToggle, onChange, onRemove }) {
  const panelId = useId();
  const context = contextNumber(model.context);
  const shownContext = context ?? defaults?.contextTokens ?? null;
  const limit = defaults?.maxOutputTokens ?? null;
  const tooSmall = shownContext !== null && limit !== null && shownContext <= limit;
  const summary = [model.vision && "能看图片", model.pdf && "能直接读 PDF", model.reasoning && "支持思考"].filter(Boolean);
  if (shownContext !== null) summary.push(`上下文 ${grouped(shownContext)}${context === null ? "（默认）" : ""}`);
  const contextHint = [
    `模型一次能读的内容，以 token 计，${grouped(CONTEXT_MIN)} 到 ${grouped(CONTEXT_MAX)}。`,
    defaults ? `留空时用默认的 ${grouped(defaults.contextTokens)}。` : "留空时用默认值。",
    limit !== null ? `需要大于每次回复的输出上限 ${grouped(limit)}，Agent 才能使用这个模型。` : "需要大于每次回复的输出上限，Agent 才能使用这个模型。",
  ].join("");
  const flag = (key) => (event) => onChange({ ...model, [key]: event.target.checked });
  return (
    <li>
      <div className="member-body">
        <strong>{model.name}</strong>
        <p>
          {summary.join(" · ")}
          {tooSmall && " · 上下文太小，Agent 不能使用"}
        </p>
        {open && (
          <div id={panelId}>
            <fieldset className="checks">
              <legend className="sr-only">{model.name} 能做什么</legend>
              <label>
                <input type="checkbox" checked={model.vision} onChange={flag("vision")} />
                <span>能看图片 <small>发给它的图片会交给模型，否则只告诉它文件名</small></span>
              </label>
              <label>
                <input type="checkbox" checked={model.pdf} onChange={flag("pdf")} />
                <span>能直接读 PDF <small>PDF 会原样交给模型，否则只告诉它文件名</small></span>
              </label>
              <label>
                <input type="checkbox" checked={model.reasoning} onChange={flag("reasoning")} />
                <span>支持思考 <small>用它的 Agent 可以选择思考程度</small></span>
              </label>
            </fieldset>
            <Field label="上下文容量" hint={contextHint} error={error}>
              <input
                value={model.context}
                onChange={(e) => onChange({ ...model, context: e.target.value })}
                inputMode="numeric"
                autoComplete="off"
                placeholder={defaults ? String(defaults.contextTokens) : ""}
              />
            </Field>
          </div>
        )}
      </div>
      <div className="member-actions">
        <Btn small aria-label={`高级设置：${model.name}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
          高级
        </Btn>
        <Btn small aria-label={`移除：${model.name}`} onClick={onRemove}>移除</Btn>
      </div>
    </li>
  );
}

/**
 * Add (no `provider`) or edit one of my providers. The key is typed into an uncontrolled password field: it is never
 * held in React state, never written back into the page, read once when the request is built, and the field is emptied
 * as soon as that request is sent (whatever its answer). Editing sends only what changed; an empty key keeps the saved one.
 */
function ProviderForm({ provider = null, created = false, onBack, onCreated }) {
  const { state, dispatch, actions } = useStore();
  // From `GET /api/models`: a model's context when none is given, and the output limit of every call (null while unknown).
  const defaults = state.providerDefaults;
  const { busy, run } = useAction();
  const formRef = useRef(null);
  const keyRef = useRef(null);
  const [f, setF] = useState(() => ({ name: provider?.name ?? "", protocol: provider?.protocol ?? PROTOCOLS[0][0], baseUrl: provider?.baseUrl ?? "" }));
  const [models, setModels] = useState(() => (provider?.models ?? []).map(formModel));
  const latestModels = useRef(models);
  latestModels.current = models;
  /** Whether something is typed in the key field, and what is wrong with it: never the key itself. */
  const [key, setKey] = useState({ given: false, problem: "" });
  /** A request carried the key and was refused: the field was emptied, so it says to fill it in again. */
  const [keyCleared, setKeyCleared] = useState(false);
  const [touched, setTouched] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [newModel, setNewModel] = useState("");
  const [newModelError, setNewModelError] = useState("");
  /** Names of the models whose 高级 is open. */
  const [open, setOpen] = useState(() => new Set());
  const [refreshNote, setRefreshNote] = useState(null);
  const { result: testResult, test } = useConnectionTest(provider?.id ?? null, run);

  const editing = provider !== null;
  const address = f.baseUrl.trim();
  const addressChanged = editing && address !== provider.baseUrl;
  const originChanged = addressChanged && originOf(address) !== originOf(provider.baseUrl);
  // 测试连接 and 从供应商读取 use the saved address and key: not while new ones wait to be saved.
  const unsaved = addressChanged || key.given;

  // Adding needs a key; editing keeps the saved one unless the address moved to another origin.
  const keyError = key.given ? key.problem : editing ? (originChanged ? KEY_AGAIN : "") : keyCleared ? KEY_CLEARED : "请填写密钥";
  const contextErrors = Object.fromEntries(models.map((m) => [m.name, contextProblem(m.context)]));
  const errors = { name: nameProblem(f.name), baseUrl: addressProblem(f.baseUrl), key: keyError };
  const invalid = Object.values(errors).some(Boolean) || Object.values(contextErrors).some(Boolean);
  const shown = (field) => (touched ? errors[field] : "");
  const nameError = shown("name") || (refusal?.code === "name_taken" ? refusal.text : "");

  const keyHint = keyCleared
    ? KEY_CLEARED
    : !editing
      ? "保存后不会再显示，之后只显示最后 4 位。"
      : originChanged
        ? KEY_AGAIN
        : `已保存的密钥：…${provider.keyLast4}。留空则保持不变，填写则替换它。`;

  const set = (field) => (event) => {
    const value = event.target.value;
    setF((cur) => ({ ...cur, [field]: value }));
    if (field === "name" && refusal?.code === "name_taken") setRefusal(null);
  };
  const onKey = (event) => {
    const value = event.target.value;
    setKey({ given: value.trim() !== "", problem: value.trim() ? keyFormatProblem(value) : "" });
    setKeyCleared(false);
  };
  /** The key leaves the page: the field is emptied (the request already holds it). */
  const dropKey = () => {
    if (keyRef.current) keyRef.current.value = "";
    setKey({ given: false, problem: "" });
  };

  const addModel = () => {
    const name = newModel.trim();
    const problem = modelNameProblem(name, models);
    setNewModelError(problem);
    if (problem) return;
    setModels((cur) => [...cur, { name, vision: false, pdf: false, reasoning: false, context: "" }]);
    setNewModel("");
  };
  const changeModel = (name, next) => setModels((cur) => cur.map((m) => (m.name === name ? next : m)));
  const removeModel = (name) => {
    setModels((cur) => cur.filter((m) => m.name !== name));
    setOpen((cur) => new Set([...cur].filter((n) => n !== name)));
  };
  const toggle = (name) => setOpen((cur) => (cur.has(name) ? new Set([...cur].filter((n) => n !== name)) : new Set([...cur, name])));

  const refused = (error, sentKey) => {
    if (sentKey) setKeyCleared(true);
    if (error?.code === "busy_here") return;
    const code = error?.error?.code ?? "unknown";
    const text = refusalText(error);
    setRefusal({ code, text });
    // Gone meanwhile: the page goes back to the list, where this form's notice would not be seen.
    if (code === "not_found") dispatch({ type: "toast", text });
    if (code === "name_taken") focusInvalid(formRef.current);
  };

  const create = async () => {
    const body = { name: f.name.trim(), protocol: f.protocol, baseUrl: address, apiKey: keyRef.current.value.trim() };
    const list = models.map(wireModel);
    if (list.length > 0) body.models = list;
    const pending = run("save", () => settled(actions.createProvider(body)), () => "");
    dropKey();
    const res = await pending;
    if (!res.ok) return refused(res.error, true);
    if (res.value?.id) onCreated(res.value.id);
    else onBack();
  };

  const save = async () => {
    const patch = {};
    const name = f.name.trim();
    if (name !== provider.name) patch.name = name;
    if (addressChanged) patch.baseUrl = address;
    const list = models.map(wireModel);
    if (modelsKey(list) !== modelsKey(provider.models)) patch.models = list;
    const apiKey = keyRef.current.value.trim();
    if (apiKey) patch.apiKey = apiKey;
    if (Object.keys(patch).length === 0) {
      onBack();
      return;
    }
    const pending = run("save", () => settled(actions.patchProvider(provider.id, patch)), () => "");
    dropKey();
    const res = await pending;
    if (!res.ok) return refused(res.error, Boolean(apiKey));
    dispatch({ type: "toast", text: "供应商已保存" });
    onBack();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null) return;
    setTouched(true);
    setRefusal(null);
    if (invalid) {
      // A model whose context is wrong shows its 高级, so the field can be seen and focused.
      const wrong = models.filter((m) => contextErrors[m.name]).map((m) => m.name);
      if (wrong.length > 0) setOpen((cur) => new Set([...cur, ...wrong]));
      focusInvalid(formRef.current);
      return;
    }
    if (editing) await save();
    else await create();
  };

  /** The provider's own model list, merged in: the names it listed that the list here does not have yet. */
  const refresh = async () => {
    setRefreshNote(null);
    const res = await run("refresh", () => settled(actions.refreshProviderModels(provider.id)), () => "");
    if (!res.ok) {
      if (res.error?.code !== "busy_here") setRefreshNote({ ok: false, text: refusalText(res.error) });
      return;
    }
    const listed = Array.isArray(res.value?.listed) ? res.value.listed : [];
    const names = new Set(listed);
    const current = latestModels.current;
    const next = [...current];
    const have = new Set(current.map((m) => m.name));
    for (const m of res.value?.provider?.models ?? []) {
      if (next.length >= MAX_MODELS) break;
      if (names.has(m.name) && !have.has(m.name)) {
        next.push(formModel(m));
        have.add(m.name);
      }
    }
    const added = next.length - current.length;
    setModels(next);
    setRefreshNote({
      ok: true,
      text:
        listed.length === 0
          ? "供应商没有列出任何模型，可以手动添加。"
          : `找到 ${listed.length} 个模型，${added > 0 ? `已把其中 ${added} 个新的加入列表。` : "列表里都已经有了。"}`,
    });
  };

  const onNewModelKey = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addModel();
  };

  return (
    <section className="page" aria-label={editing ? "编辑模型供应商" : "添加模型供应商"}>
      <button type="button" className="back" onClick={onBack}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回
      </button>
      <header className="profile-head">
        <div>
          <p className="eyebrow">模型供应商</p>
          <h2>{editing ? `编辑 ${provider.name}` : "添加供应商"}</h2>
        </div>
      </header>
      <form ref={formRef} className="page-body form" onSubmit={submit} noValidate>
        {created && <Notice tone="ok">已添加。现在可以测试连接，或从供应商读取它的模型列表。</Notice>}
        <Field label="名称" hint="只给你自己看，用来区分不同的供应商。" error={nameError}>
          <input value={f.name} onChange={set("name")} autoComplete="off" placeholder="例如：我的 OpenAI" />
        </Field>
        {editing ? (
          <div className="field">
            <span className="field-label">接口类型</span>
            <p className="readonly"><Lock size={14} aria-hidden="true" /> {protocolLabel(provider.protocol)}（创建后不可修改）</p>
          </div>
        ) : (
          <Field label="接口类型" hint="供应商的接口和哪一种一样，就选哪一种。创建后不可修改。">
            <select value={f.protocol} onChange={set("protocol")}>
              {PROTOCOLS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="接口地址" hint={`需要以 https:// 开头，例如 ${EXAMPLE_ADDRESS[editing ? provider.protocol : f.protocol] ?? EXAMPLE_ADDRESS.openai_chat}`} error={shown("baseUrl")}>
          <input value={f.baseUrl} onChange={set("baseUrl")} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" placeholder={EXAMPLE_ADDRESS[f.protocol]} />
        </Field>
        <Field label="密钥" hint={keyHint} error={shown("key")}>
          <input ref={keyRef} type="password" defaultValue="" onChange={onKey} autoComplete="new-password" autoCapitalize="none" spellCheck={false} />
        </Field>
        {editing && (
          <div className="field">
            <div className="member-actions">
              <Btn small disabled={busy !== null || unsaved} reason="新的接口地址或密钥还没保存" onClick={test}>
                {busy === "test" ? "测试中…" : "测试连接"}
              </Btn>
            </div>
            <TestResult result={testResult} />
          </div>
        )}

        <h3>模型</h3>
        <p className="muted">Agent 只能使用列在这里的模型。名称要和供应商那边的模型名完全一致。</p>
        {models.length === 0 ? (
          <p className="muted">还没有模型。</p>
        ) : (
          <ul className="member-rows" aria-label="模型列表">
            {models.map((m) => (
              <ModelRow
                key={m.name}
                model={m}
                open={open.has(m.name)}
                error={touched ? contextErrors[m.name] : ""}
                defaults={defaults}
                onToggle={() => toggle(m.name)}
                onChange={(next) => changeModel(m.name, next)}
                onRemove={() => removeModel(m.name)}
              />
            ))}
          </ul>
        )}
        <Field label="模型名称" hint={`最多 ${MAX_MODELS} 个模型。`} error={newModelError}>
          <input value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={onNewModelKey} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </Field>
        <div className="member-actions">
          <Btn small onClick={addModel}>添加模型</Btn>
          {editing && (
            <Btn small disabled={busy !== null || unsaved} reason="新的接口地址或密钥还没保存" onClick={refresh}>
              {busy === "refresh" ? "读取中…" : "从供应商读取"}
            </Btn>
          )}
        </div>
        {refreshNote && (refreshNote.ok ? <p className="field-hint" role="status">{refreshNote.text}</p> : <p className="field-msg" role="alert">{refreshNote.text}</p>)}
        <p className="field-hint">
          {editing ? "从供应商读取会用已保存的地址和密钥。有的供应商不提供模型列表，这时请手动添加。" : "保存后可以从供应商读取它的模型列表；也可以在这里手动添加。"}
        </p>
        {editing && unsaved && <Reason>请先保存新的接口地址或密钥，再测试连接或从供应商读取。</Reason>}

        <Notice tone="info">{PRIVACY_TEXT}</Notice>
        {refusal && refusal.code !== "name_taken" && <Notice tone="warn">{refusal.text}</Notice>}
        <div className="form-actions">
          <Btn onClick={onBack}>取消</Btn>
          <Btn variant="primary" type="submit" disabled={busy !== null}>
            {busy === "save" ? "保存中…" : "保存"}
          </Btn>
        </div>
      </form>
    </section>
  );
}

/**
 * Settings › 模型供应商: my providers (read again whenever the section opens), and the form to add or edit one.
 * `back`: the settings back button (to the settings list on a phone).
 */
export function ProvidersPage({ back }) {
  const { state, actions } = useStore();
  /** {mode: "list"} | {mode: "new"} | {mode: "edit", id, created} */
  const [view, setView] = useState({ mode: "list" });
  const [load, setLoad] = useState("loading");
  const [removing, setRemoving] = useState(null);
  const reload = useCallback(async () => {
    setLoad("loading");
    const res = await actions.loadProviders();
    setLoad(res.ok ? "ok" : "failed");
  }, [actions]);
  useEffect(() => {
    reload();
  }, [reload]);
  // The limits shown with a model's context (normally loaded with the connection).
  const defaultsKnown = state.providerDefaults !== null;
  useEffect(() => {
    if (!defaultsKnown) actions.loadModels();
  }, [actions, defaultsKnown]);

  const providers = Object.values(state.providers);
  const editing = view.mode === "edit" ? state.providers[view.id] ?? null : null;
  const toList = () => setView({ mode: "list" });

  if (view.mode === "new") return <ProviderForm key="new" onBack={toList} onCreated={(id) => setView({ mode: "edit", id, created: true })} />;
  if (editing) return <ProviderForm key={editing.id} provider={editing} created={view.created} onBack={toList} />;

  const full = providers.length >= MAX_PROVIDERS;
  return (
    <section className="page" aria-label="模型供应商">
      {back}
      <header className="profile-head">
        <div className="grow">
          <p className="eyebrow">模型供应商</p>
          <h2>我的模型供应商</h2>
          <p className="muted">在模型服务商那里有账号的话，把它的接口地址和密钥填在这里，你的 Agent 就可以用它的模型回复。用自己的供应商不扣本站的点数。</p>
        </div>
        <div className="head-actions">
          <Btn variant="primary" disabled={full} reason="最多只能添加 10 个模型供应商" onClick={() => setView({ mode: "new" })}>
            <Plus size={16} aria-hidden="true" /> 添加供应商
          </Btn>
        </div>
      </header>
      <div className="page-body">
        {full && <Reason>最多只能添加 10 个模型供应商。删除不用的之后可以再添加。</Reason>}
        {load === "failed" && (
          <Reason>
            没能读取你的模型供应商，请重试。 <Btn small onClick={reload}>重试</Btn>
          </Reason>
        )}
        {providers.length > 0 ? (
          <ul className="member-rows" aria-label="我的模型供应商">
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} onEdit={() => setView({ mode: "edit", id: p.id, created: false })} onDelete={() => setRemoving(p)} />
            ))}
          </ul>
        ) : load === "loading" ? (
          <p className="muted">正在读取…</p>
        ) : load === "ok" ? (
          <p className="muted">还没有添加模型供应商。</p>
        ) : null}
      </div>
      {removing && <DeleteModal provider={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}
