import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { Avatar, Btn } from "../ui/primitives.jsx";
import { useAction } from "./useAction.js";

/** What the service accepts as an avatar (it decides by the bytes; the client only spares an upload that cannot work). */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** The reason a picked file cannot be an avatar, or "" when it may be tried. */
export function avatarFileProblem(file) {
  const typeKnown = AVATAR_TYPES.includes(file.type) || (file.type === "" && /\.(png|jpe?g|webp)$/i.test(file.name));
  if (!typeKnown) return "头像需要是 PNG、JPEG 或 WebP 格式的图片。";
  if (file.size > MAX_AVATAR_BYTES) return "头像不能超过 2 MB。";
  return "";
}

/**
 * Pick an image, see it, then save it (or drop it). The preview URL is revoked as soon as it is not shown any more.
 * - With `upload(file)` (a promise that rejects on a refusal): 保存头像 sends it at once; `errorText(error)` is toasted
 *   when it fails, `doneText` when it worked. My own avatar, an existing Agent's.
 * - With `onPick(file | null)` instead: the picked file is only held, for the page to send later (a new Agent's, once
 *   it exists). `disabled` while the page is busy.
 * `id`: whose avatar shows while nothing is picked (null: the blank one of an Agent not created yet). `hint` replaces the
 * line under it (the formats and the size, by default).
 */
export function AvatarEditor({ id = ME, upload, errorText, doneText = "头像已更新", onPick, disabled = false, hint }) {
  const { dispatch } = useStore();
  const { busy, run } = useAction();
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState("");
  const urlRef = useRef(null);
  const inputRef = useRef(null);
  const held = typeof onPick === "function";

  const discard = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPicked(null);
  };
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const choose = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    discard();
    const problem = avatarFileProblem(file);
    setError(problem);
    if (problem) {
      if (held) onPick(null);
      return;
    }
    urlRef.current = URL.createObjectURL(file);
    setPicked({ file, url: urlRef.current });
    if (held) onPick(file);
  };

  const save = async () => {
    const res = await run("avatar", () => upload(picked.file), errorText);
    if (!res.ok) return;
    discard();
    setError("");
    dispatch({ type: "toast", text: doneText });
  };

  const drop = () => {
    discard();
    if (held) onPick(null);
  };
  const browse = () => inputRef.current?.click();

  let buttons;
  if (held) {
    buttons = picked ? (
      <>
        <Btn disabled={disabled} onClick={browse}>换一张</Btn>
        {/* Not "取消": the form around it has its own. */}
        <Btn disabled={disabled} onClick={drop}>不用这张</Btn>
      </>
    ) : (
      <Btn disabled={disabled} onClick={browse}>选择头像</Btn>
    );
  } else {
    buttons = picked ? (
      <>
        <Btn variant="primary" disabled={busy !== null} onClick={save}>{busy === "avatar" ? "保存中…" : "保存头像"}</Btn>
        <Btn disabled={busy !== null} onClick={discard}>取消</Btn>
      </>
    ) : (
      <Btn onClick={browse}>更换头像</Btn>
    );
  }

  return (
    <div className="avatar-editor">
      {picked ? (
        <span className="avatar avatar-preview" style={{ width: 84, height: 84 }}>
          <span className="avatar-img avatar-fallback" style={{ width: 84, height: 84 }}>
            <img src={picked.url} alt="新头像预览" />
          </span>
        </span>
      ) : (
        <Avatar id={id} size={84} />
      )}
      <div className="stack-actions row-actions">
        <input ref={inputRef} type="file" accept={AVATAR_TYPES.join(",")} hidden aria-label="选择头像图片" onChange={choose} />
        {buttons}
      </div>
      <p className={error ? "field-msg" : "field-hint"} role={error ? "alert" : undefined}>
        {error || hint || (held ? "支持 PNG、JPEG、WebP，不超过 2 MB；不选择则使用默认头像。" : "支持 PNG、JPEG、WebP，不超过 2 MB。")}
      </p>
    </div>
  );
}
