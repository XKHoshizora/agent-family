import React, { useCallback, useEffect, useId, useState } from "react";
import { useStore } from "../data/store.jsx";
import { Btn, Notice, Reason } from "../ui/primitives.jsx";
import { LabLogo, labOfModel } from "../ui/LabLogo.jsx";

/** The reasoning levels in the service's order, and how the form says them. */
export const LEVELS = [
  ["none", "不思考"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "很高"],
  ["max", "最高"],
];
const ALL_LEVELS = LEVELS.map(([id]) => id);
export const levelLabel = (level) => LEVELS.find(([id]) => id === level)?.[1] ?? level;

export const PRIVACY_TEXT = "你与它的对话内容，包括发给它的图片和文件，会发送给所选模型的服务商。";

/** A model choice as a `<select>` value: the same choice always gives the same key ("" for none). */
export const modelKey = (model) =>
  !model ? "" : JSON.stringify(model.source === "site" ? ["site", model.id] : ["provider", model.providerId, model.model]);

/** What a model is called on screen: a site model's label, a provider model's name (after its provider's, when known). */
export function modelLabel(state, model) {
  if (!model) return null;
  if (model.source === "site") return state.siteModels.find((m) => m.id === model.id)?.label ?? model.id;
  const provider = state.providers[model.providerId];
  return provider ? `${provider.name} · ${model.model}` : model.model;
}

/** The lab of a chosen model, for its logo: a site model by its id, then its label; a provider model by its name; else null. */
export function modelLab(state, model) {
  if (!model) return null;
  if (model.source === "site") {
    const site = state.siteModels.find((m) => m.id === model.id);
    return labOfModel(model.id) ?? labOfModel(site?.label);
  }
  return labOfModel(model.model);
}

/**
 * What can be chosen now: the site's models and each of my providers with its models. Each choice is
 * `{key, model, label, paid, levels, usable}`: `levels` the reasoning levels it allows (`none` first); a provider model whose
 * context is not larger than the output limit its calls get cannot be used (the service refuses it).
 */
export function modelChoices(state) {
  const limit = state.providerDefaults?.maxOutputTokens ?? 0;
  const site = state.siteModels.map((m) => {
    const model = { source: "site", id: m.id };
    const paid = m.tier === "paid";
    return { key: modelKey(model), model, label: `${m.label} · ${paid ? "需余额" : "免费"}`, paid, levels: ALL_LEVELS.filter((l) => l === "none" || m.reasoning.includes(l)), usable: true };
  });
  const providers = Object.values(state.providers).map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => {
      const model = { source: "provider", providerId: p.id, model: m.name };
      const tooSmall = Number.isFinite(m.contextTokens) && m.contextTokens <= limit;
      // A model that lists the levels it supports offers those (as a site model does), else every level when it reasons.
      const levels = !m.reasoning ? ["none"] : m.reasoningLevels ? ALL_LEVELS.filter((l) => l === "none" || m.reasoningLevels.includes(l)) : ALL_LEVELS;
      return { key: modelKey(model), model, label: tooSmall ? `${m.name}（上下文太小）` : m.name, paid: false, levels, usable: !tooSmall };
    }),
  }));
  const any = site.length > 0 || providers.some((p) => p.models.some((m) => m.usable));
  return { site, providers, any };
}

/**
 * The choices of a form as one list: what can be chosen, and before it the Agent's current model when it cannot be
 * chosen any more (no longer offered, or too small), so that keeping it is still possible (`stale: true`).
 */
export function choiceList(sources, current = null, currentReasoning = "none") {
  const offered = [...sources.choices.site, ...sources.choices.providers.flatMap((p) => p.models)];
  const key = modelKey(current);
  if (!current || offered.some((c) => c.key === key && c.usable)) return offered.filter((c) => c.usable);
  const levels = ALL_LEVELS.filter((l) => l === "none" || l === currentReasoning);
  return [{ key, model: current, label: `${sources.labelOf(current)}（当前，已不可用）`, paid: false, levels, usable: true, stale: true }, ...offered.filter((c) => c.usable)];
}

/**
 * Loads what the picker offers (the site's models, my providers, my usage for the balance) when a form opens, and says
 * how far that got: `status` "loading" | "ready"; `nothing` once it is known that no model at all can be chosen.
 */
export function useModelSources() {
  const { state, actions } = useStore();
  const [providers, setProviders] = useState("loading");
  const [models, setModels] = useState("loading");
  const loadProviders = useCallback(async () => {
    setProviders("loading");
    const res = await actions.loadProviders();
    setProviders(res.ok ? "ok" : "failed");
  }, [actions]);
  const loadModels = useCallback(async () => {
    setModels("loading");
    const res = await actions.loadModels();
    setModels(res.ok ? "ok" : "failed");
  }, [actions]);
  useEffect(() => {
    loadProviders();
    loadModels();
    actions.loadUsage();
  }, [actions, loadProviders, loadModels]);

  // The site's models are known once any load of them succeeded (the connection loads them too).
  const modelsKnown = state.providerDefaults !== null || models === "ok";
  const choices = modelChoices(state);
  const loading = providers === "loading" || (!modelsKnown && models === "loading");
  return {
    status: loading ? "loading" : "ready",
    providersKnown: providers === "ok",
    modelsKnown,
    nothing: !loading && providers === "ok" && modelsKnown && !choices.any,
    failed: loading ? null : providers === "failed" ? "providers" : !modelsKnown ? "models" : null,
    retry: () => {
      if (providers === "failed") loadProviders();
      if (!modelsKnown) loadModels();
    },
    choices,
    usage: state.usage,
    labelOf: (model) => modelLabel(state, model),
  };
}

/** Whether a balance (the service's decimal string) is above zero, read without arithmetic. */
const positive = (balance) => typeof balance === "string" && !balance.trim().startsWith("-") && /[1-9]/.test(balance);

function paidText(usage) {
  if (!usage || typeof usage.balance !== "string") return "需要余额：这个模型按用量从余额扣点，余额用完后它不会回复；最后一次回复可能把余额扣成负数。";
  if (positive(usage.balance)) return `这个模型按用量从余额扣点，你现在的余额是 ${usage.balanceText} 点。`;
  return `需要余额：这个模型按用量从余额扣点，你现在的余额是 ${usage.balanceText} 点，余额用完后它不会回复；最后一次回复可能把余额扣成负数。`;
}

/**
 * The groups of options a model `<select>` offers: 站点提供 (each model 免费 or 需余额) and 我的供应商 (provider → its
 * models); what cannot be read yet is said inside its group. `sources`: `useModelSources()`.
 */
export function ModelGroups({ sources }) {
  const { site, providers } = sources.choices;
  return (
    <>
      <optgroup label="站点提供">
        {!sources.modelsKnown ? (
          <option disabled value="site-unknown">暂时读取不到</option>
        ) : site.length === 0 ? (
          <option disabled value="site-closed">尚未开放</option>
        ) : (
          site.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)
        )}
      </optgroup>
      {!sources.providersKnown || providers.length === 0 ? (
        <optgroup label="我的供应商">
          <option disabled value="providers-none">{sources.providersKnown ? "还没有添加供应商" : "暂时读取不到"}</option>
        </optgroup>
      ) : (
        providers.map((p) => (
          <optgroup key={p.id} label={`我的供应商 · ${p.name}`}>
            {p.models.length === 0 ? (
              <option disabled value={`provider-empty-${p.id}`}>没有可选的模型</option>
            ) : (
              p.models.map((m) => (
                <option key={m.key} value={m.key} disabled={!m.usable}>{m.label}</option>
              ))
            )}
          </optgroup>
        ))
      )}
    </>
  );
}

/**
 * The model field of the Agent form: two groups, 站点提供 (each model 免费 or 需余额) and 我的供应商 (provider → its models);
 * a notice leading to Settings › 模型供应商 when nothing at all can be chosen; the privacy notice beside it.
 * `options`: `choiceList(sources, …)`; `value`: the chosen key; `onChange(key)`.
 */
export function ModelPicker({ sources, options, value, onChange }) {
  const { dispatch } = useStore();
  const id = useId();
  const chosen = options.find((o) => o.key === value) ?? null;
  const stale = options.filter((o) => o.stale);
  const showSelect = sources.status === "ready" && !sources.nothing;
  const addProvider = () => dispatch({ type: "nav", patch: { section: "settings", settingsPage: "providers", pane: "main" } });

  let control;
  if (sources.status === "loading") control = <p className="muted">正在读取可用的模型…</p>;
  else if (sources.nothing) {
    control = (
      <Notice tone="info" action={<Btn small onClick={addProvider}>添加模型供应商</Btn>}>
        还没有可用的模型：本站的模型尚未开放，你也还没有可用的模型供应商。添加一个供应商并填好它的模型后，就可以给 Agent 选择模型了。
      </Notice>
    );
  } else {
    control = (
      <select id={id} value={chosen ? value : ""} onChange={(e) => onChange(e.target.value)} aria-describedby={chosen?.paid ? `${id}-paid` : undefined}>
        {!chosen && <option value="">请选择模型</option>}
        {stale.map((o) => (
          <option key={`current-${o.key}`} value={o.key}>{o.label}</option>
        ))}
        <ModelGroups sources={sources} />
      </select>
    );
  }

  return (
    <div>
      <div className="field">
        {showSelect ? <label htmlFor={id}>模型</label> : <span className="field-label">模型</span>}
        {control}
        {sources.failed && (
          <Reason>
            {sources.failed === "providers" ? "没能读取你的模型供应商，请重试。" : "没能读取本站的模型，请重试。"}{" "}
            <Btn small onClick={sources.retry}>重试</Btn>
          </Reason>
        )}
        {chosen?.paid && <p id={`${id}-paid`} className="field-hint">{paidText(sources.usage)}</p>}
      </div>
      <Notice tone="info">{PRIVACY_TEXT}</Notice>
    </div>
  );
}
