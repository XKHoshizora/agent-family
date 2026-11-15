import React, { useEffect, useId, useRef } from "react";
import { X, Info, CircleAlert, CircleCheck, CirclePause, Bot } from "../icons.js";
import { useStore } from "../state/store.jsx";
import { entity, isAgent, nameOf, ownerOf, otherMember } from "../state/selectors.js";
import { BRAND_CELL } from "../data/identities.js";

export const asset = (path) => `${import.meta.env.BASE_URL}${String(path).replace(/^\//, "")}`;
const ATLAS = asset("assets/identities.png");

export function cellStyle(cell, size) {
  const [col, row] = cell;
  return {
    width: size,
    height: size,
    backgroundImage: `url(${ATLAS})`,
    backgroundSize: "300% 300%",
    backgroundPosition: `${col * 50}% ${row * 50}%`,
  };
}

export function Avatar({ id, size = 44, online = false, className = "" }) {
  const { state } = useStore();
  const who = entity(state, id);
  const cell = who?.cell || BRAND_CELL;
  return (
    <span className={`avatar ${className}`} style={{ width: size, height: size }} role="img" aria-label={who?.name || "头像"}>
      {cell[0] === BRAND_CELL[0] && cell[1] === BRAND_CELL[1]
        ? <span className="avatar-img agent-default" style={{ width: size, height: size }}><Bot size={Math.round(size * 0.64)} aria-hidden="true" /></span>
        : <span className="avatar-img" style={cellStyle(cell, size)} />}
      {online && <span className="avatar-dot" />}
    </span>
  );
}

export function BrandMark({ size = 36 }) {
  return <img className="brand-mark" src={asset("assets/agent-family-mark-v2.png")} width={size} height={size} alt="Agent Family" />;
}

// Composite of 2–4 speaking members. Never substitutes an owner's face for an Agent.
export function GroupAvatar({ ids, size = 46 }) {
  const list = ids.slice(0, 4);
  const small = Math.round(size * (list.length <= 2 ? 0.62 : 0.54));
  return (
    <span className={`group-avatar n${list.length}`} style={{ width: size, height: size }} role="img" aria-label="群头像">
      {list.map((id) => (
        <Avatar key={id} id={id} size={small} />
      ))}
    </span>
  );
}

export function ConvAvatar({ conv, size = 46 }) {
  if (conv.type === "human" || conv.type === "agent") return <Avatar id={otherMember(conv)} size={size} />;
  return <GroupAvatar ids={conv.members} size={size} />;
}

export function Tag({ tone = "agent", children }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function IdentityLine({ id, showOwner = true, extra }) {
  const { state } = useStore();
  const agent = isAgent(state, id);
  return (
    <span className="identity-line">
      <strong>{nameOf(state, id)}</strong>
      {agent ? <Tag>Agent</Tag> : <Tag tone="human">真人</Tag>}
      {agent && showOwner && <span className="owner">主人：{nameOf(state, ownerOf(state, id))}</span>}
      {extra}
    </span>
  );
}

const NOTICE_ICON = { info: Info, warn: CircleAlert, ok: CircleCheck, pause: CirclePause };
export function Notice({ tone = "info", children, action }) {
  const Icon = NOTICE_ICON[tone] || Info;
  return (
    <div className={`notice notice-${tone}`} role={tone === "warn" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function Btn({ variant = "ghost", small, reason, className = "", children, ...rest }) {
  return (
    <button type="button" className={`btn btn-${variant} ${small ? "btn-sm" : ""} ${className}`} title={rest.disabled ? reason : undefined} {...rest}>
      {children}
    </button>
  );
}

export function IconBtn({ label, children, className = "", ...rest }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Reason({ children }) {
  if (!children) return null;
  return (
    <p className="reason">
      <Info size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const focusables = () => node.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]");
    const first = node.querySelector("[data-autofocus]") || focusables()[0];
    first?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const list = [...focusables()];
        if (!list.length) return;
        const head = list[0];
        const tail = list[list.length - 1];
        if (e.shiftKey && document.activeElement === head) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && document.activeElement === tail) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconBtn label="关闭" onClick={onClose}>
            <X size={18} />
          </IconBtn>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  const id = useId();
  return (
    <div className={`field ${error ? "field-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, { id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? `${id}-help` : undefined })}
      {error ? <p id={`${id}-help`} className="field-msg" role="alert">{error}</p> : hint ? <p id={`${id}-help`} className="field-hint">{hint}</p> : null}
    </div>
  );
}

export function focusInvalid(container) {
  requestAnimationFrame(() => {
    const field = (container || document.querySelector('.modal') || document).querySelector('[aria-invalid="true"]');
    field?.focus({ preventScroll: true });
    field?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

export function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
