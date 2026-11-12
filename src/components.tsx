import * as Dialog from "@radix-ui/react-dialog";
import { X, Check, Copy, LoaderCircle } from "lucide-react";
import {
  useState,
  useId,
  Children,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ReactElement,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copy } from "./api";
import { toast } from "sonner";
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "small" : ""}`}>
      <svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="2.1">
          <circle cx="14" cy="15" r="9" />
          <circle cx="26" cy="15" r="9" />
          <circle cx="20" cy="26" r="9" />
        </g>
      </svg>
      <span>Agent Family</span>
    </span>
  );
}
export function Avatar({
  name,
  color = "sage",
  size = "normal",
}: {
  name: string;
  color?: string;
  size?: string;
}) {
  return (
    <span className={`avatar ${color} ${size}`} aria-hidden="true">
      {name.startsWith("小") && name.length > 1
        ? name.slice(1, 2)
        : name.slice(0, 1)}
    </span>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "wide" : ""}`}
          aria-describedby={description ? "modal-description" : undefined}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description id="modal-description">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Drawer({
  open,
  onClose,
  title,
  side,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side: "left" | "right";
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="mobile-drawer-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`mobile-drawer ${side} ${side === "left" ? "sidebar drawer-sidebar" : "members-panel drawer-members"}`}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Spinner({ label = "正在加载" }: { label?: string }) {
  return (
    <span className="loading" role="status">
      <LoaderCircle size={17} className="spin" />
      {label}
    </span>
  );
}
export function CopyButton({
  text,
  label = "复制",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="text-button"
      onClick={async () => {
        try {
          await copy(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          toast.error("复制失败，请手动选择文字。");
        }
      }}
      aria-label={label}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "已复制" : label}</span>
    </button>
  );
}
function CodeBlock({ children, ...props }: any) {
  const node = Array.isArray(children) ? children[0] : children;
  const text =
    typeof node?.props?.children === "string" ? node.props.children : "";
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>
          {node?.props?.className?.replace("language-", "") || "代码"}
        </span>
        {text && <CopyButton text={text} />}
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="image-placeholder">
              [图片：{alt || "未加载外部图片"}]
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const fieldId = useId();
  let linked = false;
  function link(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (node) => {
      if (!isValidElement(node)) return node;
      const element = node as ReactElement<any>;
      if (
        !linked &&
        ["input", "select", "textarea"].includes(element.type as string)
      ) {
        linked = true;
        return cloneElement(element, {
          id: fieldId,
          "aria-describedby": hint ? `${fieldId}-hint` : undefined,
        });
      }
      return element.props.children
        ? cloneElement(element, {}, link(element.props.children))
        : element;
    });
  }
  const content = link(children);
  return (
    <div className="field">
      {linked ? <label htmlFor={fieldId}>{label}</label> : <span>{label}</span>}
      {content}
      {hint && <small id={`${fieldId}-hint`}>{hint}</small>}
    </div>
  );
}
export function ErrorBox({ error }: { error?: string | null }) {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}
