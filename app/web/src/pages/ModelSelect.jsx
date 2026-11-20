import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "../icons.js";
import { composing } from "../ui/primitives.jsx";
import { ModelBrand } from "../ui/ModelBrand.jsx";

/** What a row's marks say, and — where the short word needs it — what they mean (the provider form's own words). */
export const MARK_TEXT = { free: "免费", paid: "需余额", thinking: "思考", tools: "工具" };
const MARK_TITLE = { thinking: "支持思考", tools: "会用工具（查聊天记录、看文件）" };
/** The marks' columns at a row's right, left to right: each kind has its own, so the marks line up from row to row. */
const COLUMNS = [
  ["price", ["free", "paid"]],
  ["thinking", ["thinking"]],
  ["tools", ["tools"]],
];

/** The marks of a row in column order. */
const marksInOrder = (option) => COLUMNS.flatMap(([, kinds]) => (option.marks ?? []).filter((m) => kinds.includes(m)));

/** What a row is called (its name, then its marks; one that cannot be chosen: its name and why). */
export const optionLabel = (option) =>
  option.disabled && option.reason ? `${option.name}（${option.reason}）` : [option.name, ...marksInOrder(option).map((m) => MARK_TEXT[m])].join(" · ");

/** The words typed, lower-cased: every one must be in a row's name, id or provider name for it to be shown. */
const wordsOf = (query) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const found = (option, words) => words.every((word) => (option.terms ?? [option.name.toLowerCase()]).some((term) => term.includes(word)));

/** The rows shown for `words`: the leading ones and each group's, a group without any left out (only while searching). */
function visible(lead, groups, words) {
  if (words.length === 0) return { lead, groups };
  return {
    lead: lead.filter((o) => found(o, words)),
    groups: groups.map((g) => ({ ...g, options: g.options.filter((o) => found(o, words)) })).filter((g) => g.options.length > 0),
  };
}
const rowsOf = (shown) => [...shown.lead, ...shown.groups.flatMap((g) => g.options)];

/** Room kept between the popover and the window's edges, and between it and its button (px). */
const EDGE = 12;
const GAP = 6;
const TALLEST = 420;
/** Below this much room under its button (about six rows) the list may open above it instead (px). */
const ENOUGH_BELOW = 240;

/** The nearest box around `node` that scrolls up and down and has more than it shows (a page's body), or null. */
function scrollerOf(node) {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}
/** The list is a sheet at the bottom of the screen (styles.css, under 480 px). */
const onPhone = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 480px)").matches;

/**
 * A model picker: a button showing the current model (its brand mark and name) that opens a searchable list of models
 * grouped by where they come from, each row with its brand mark, its name and its marks at the right (免费 / 需余额, 思考,
 * 工具), the current one ticked. Under 480 px wide the list is a sheet at the bottom of the screen.
 * `disabled`: it cannot be opened (a disabled button); `busy`: its choice is being saved — it cannot be opened either,
 * but stays focusable.
 *
 * - `value`: the key of the current choice (aria-selected), or null; `current`: {name, brand} the button shows, or null
 *   (then `placeholder`).
 * - `lead`: rows before the groups; `groups`: [{id, label, options, empty}] — `empty` is what a group without rows says.
 *   A row: {key, name, brand, marks, terms (lower-case words it is found by), disabled, reason (why it cannot be chosen)}.
 * - `id`, `labelledBy` (the field's label: the button reads "label value"), `label` (its own name instead), `describedBy`.
 * - `status`: a line shown instead of the list (it is being read); `footer`: what stands under the list.
 * - `onOpen()` when it opens; `onChange(key, row)` when another row is chosen.
 */
export function ModelSelect({
  id,
  labelledBy,
  label,
  describedBy,
  value = null,
  current = null,
  placeholder = "请选择模型",
  lead = [],
  groups = [],
  status = null,
  footer = null,
  disabled = false,
  busy = false,
  compact = false,
  onOpen,
  onChange,
}) {
  const base = useId();
  const listId = `${base}-list`;
  const valueId = `${base}-value`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const [place, setPlace] = useState(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const searchRef = useRef(null);

  // Every row's id (by its place among all rows, never by its key, which may hold anything a name may).
  const all = [...lead, ...groups.flatMap((g) => g.options)];
  const optionId = new Map(all.map((o, i) => [o.key, `${base}-o${i}`]));
  const columns = COLUMNS.filter(([, kinds]) => all.some((o) => !o.disabled && (o.marks ?? []).some((m) => kinds.includes(m))));
  const words = wordsOf(query);
  const shown = visible(lead, groups, words);
  const rows = rowsOf(shown);
  const choosable = rows.filter((o) => !o.disabled);
  // Where the keyboard is: the row moved to, else the current choice, else the first row that can be chosen.
  const activeKey = choosable.some((o) => o.key === active) ? active : (choosable.find((o) => o.key === value) ?? choosable[0])?.key ?? null;

  const show = (typed = "") => {
    if (disabled || busy || open) return;
    setQuery(typed);
    setActive(null);
    setOpen(true);
    onOpen?.();
  };
  const close = (focusButton) => {
    setOpen(false);
    setQuery("");
    if (focusButton) triggerRef.current?.focus();
  };
  const choose = (key) => {
    const row = rows.find((o) => o.key === key);
    if (!row || row.disabled) return;
    close(true);
    if (key !== value) onChange?.(key, row);
  };

  // Opened: the search field takes the focus; the popover opens under its button — its page first scrolled, as far as it
  // can with the button still in sight, so that the list has room there — and above it only when there is still not
  // enough room below and more above (laid out before it is painted, and again when the window scrolls or changes size).
  // A phone's sheet needs none of it.
  useLayoutEffect(() => {
    if (!open) return undefined;
    searchRef.current?.focus();
    const placeIt = () => {
      const button = triggerRef.current;
      if (!button) return;
      const r = button.getBoundingClientRect();
      const width = Math.min(compact ? 380 : Math.max(r.width, 320), window.innerWidth - 2 * EDGE);
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - width));
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = below < ENOUGH_BELOW && above > below;
      const height = Math.max(160, Math.min(TALLEST, up ? above : below));
      setPlace(up ? { up, left, width, height, bottom: window.innerHeight - r.top + GAP } : { up, left, width, height, top: r.bottom + GAP });
    };
    const button = triggerRef.current;
    if (button && !onPhone()) {
      button.scrollIntoView?.({ block: "nearest" });
      // As tall as the list is now (at most TALLEST), and never less than ENOUGH_BELOW.
      const want = Math.min(TALLEST, Math.max(popRef.current?.offsetHeight ?? 0, ENOUGH_BELOW));
      const r = button.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const scroller = below < want ? scrollerOf(button) : null;
      if (scroller) {
        const shown = Math.max(scroller.getBoundingClientRect().top, 0);
        const by = Math.min(want - below, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop, r.top - shown - EDGE);
        if (by > 0) scroller.scrollTop += by;
      }
    }
    placeIt();
    const onScroll = (event) => {
      if (!popRef.current?.contains(event.target)) placeIt();
    };
    window.addEventListener("resize", placeIt);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", placeIt);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, compact]);

  // A press anywhere else closes it (the focus goes where the press put it); Esc closes it wherever the focus is.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (popRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // The row the keyboard is on stays in view.
  useLayoutEffect(() => {
    if (open && activeKey !== null) document.getElementById(optionId.get(activeKey))?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeKey]);

  // Closed while saving (the button turns off): nothing stays open over it.
  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled]);

  const move = (step) => {
    const at = choosable.findIndex((o) => o.key === activeKey);
    const next = choosable[Math.max(0, Math.min(choosable.length - 1, at + step))];
    if (next) setActive(next.key);
  };
  const onSearchKey = (event) => {
    if (composing(event)) return;
    // (While what can be chosen is still being read, no row is shown, so none is moved to or chosen.)
    if (status && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter")) {
      event.preventDefault();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeKey !== null) choose(activeKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // The focus goes back to the button now, so the browser's own Tab moves on from there.
      close(true);
    }
  };
  const onSearch = (event) => {
    const next = event.target.value;
    setQuery(next);
    setActive(rowsOf(visible(lead, groups, wordsOf(next))).find((o) => !o.disabled)?.key ?? null);
  };
  const onTriggerKey = (event) => {
    if (open || disabled || busy) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show();
    } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead is the search field: what is typed on the button starts the search.
      event.preventDefault();
      show(event.key);
    }
  };

  const row = (option) => {
    const selected = option.key === value;
    const marks = option.marks ?? [];
    return (
      <div
        key={option.key}
        id={optionId.get(option.key)}
        role="option"
        className={`model-option${option.key === activeKey ? " active" : ""}`}
        aria-selected={selected}
        aria-disabled={option.disabled || undefined}
        aria-label={optionLabel(option)}
        title={option.disabled ? option.reason ?? undefined : undefined}
        onMouseMove={() => !option.disabled && option.key !== active && setActive(option.key)}
        onClick={() => choose(option.key)}
      >
        <span className="model-check" aria-hidden="true">{selected && <Check size={14} />}</span>
        <ModelBrand brand={option.brand} />
        <span className="model-name" title={option.name}>{option.name}</span>
        {option.disabled ? (
          option.reason && <span className="model-reason" aria-hidden="true">{option.reason}</span>
        ) : (
          columns.length > 0 && (
            <span className="model-marks" aria-hidden="true">
              {columns.map(([col, kinds]) => {
                const mark = marks.find((m) => kinds.includes(m));
                return (
                  <span key={col} data-col={col} className={mark ? `model-mark model-mark-${mark}` : "model-mark"} title={mark ? MARK_TITLE[mark] : undefined}>
                    {mark ? MARK_TEXT[mark] : null}
                  </span>
                );
              })}
            </span>
          )
        )}
      </div>
    );
  };

  const popStyle = place && { "--pop-left": `${place.left}px`, "--pop-w": `${place.width}px`, "--pop-h": `${place.height}px`, ...(place.up ? { "--pop-bottom": `${place.bottom}px` } : { "--pop-top": `${place.top}px` }) };
  const popover =
    open &&
    createPortal(
      <>
        <div className="model-scrim" aria-hidden="true" />
        <div ref={popRef} className={`model-pop${place?.up ? " up" : ""}`} style={popStyle ?? undefined}>
          <div className="model-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              role="combobox"
              aria-label="搜索模型"
              aria-expanded="true"
              aria-controls={status ? undefined : listId}
              aria-autocomplete="list"
              aria-activedescendant={!status && activeKey !== null ? optionId.get(activeKey) : undefined}
              placeholder="搜索模型…"
              value={query}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              onChange={onSearch}
              onKeyDown={onSearchKey}
            />
          </div>
          {status ? (
            <p className="model-empty" role="status">{status}</p>
          ) : (
            <>
              {/* A press on a row or a group's name leaves the focus in the search field (one on the list's own scrollbar is let through). */}
              <div className="model-list" role="listbox" id={listId} aria-label="模型" onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}>
                {shown.lead.map(row)}
                {shown.groups.map((g) => (
                  <div key={g.id} role="group" aria-label={g.label} className="model-group">
                    <div className="model-group-label" aria-hidden="true">{g.label}</div>
                    {g.options.length > 0 ? (
                      g.options.map(row)
                    ) : (
                      <div role="option" aria-selected="false" aria-disabled="true" className="model-option model-note">{g.empty}</div>
                    )}
                  </div>
                ))}
              </div>
              {words.length > 0 && rows.length === 0 && <p className="model-empty" role="status">没有匹配的模型</p>}
            </>
          )}
          {footer && <div className="model-foot">{footer}</div>}
        </div>
      </>,
      document.body,
    );

  // (While its choice is being saved the button does nothing, aria-disabled, yet keeps the focus a disabled one would drop.)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`model-trigger${compact ? " compact" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && !status ? listId : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        title={current?.name}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {current && <ModelBrand brand={current.brand} size={compact ? 14 : 16} />}
        <span className="model-name" id={valueId}>{current?.name ?? placeholder}</span>
        <ChevronDown className="model-chevron" size={compact ? 13 : 16} aria-hidden="true" />
      </button>
      {popover}
    </>
  );
}
