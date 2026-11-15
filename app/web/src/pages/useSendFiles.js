import { useCallback } from "react";
import { useStore } from "../data/store.jsx";
import { MAX_FILE_BYTES } from "../data/actions.js";
import { FILE_LIMIT_TEXT } from "../data/uploadErrors.js";

/**
 * The files of a drop, without folders (a dropped folder shows up as a File that cannot be read and would only
 * fail). Browsers that say what each item is (`webkitGetAsEntry`) decide by that; otherwise an empty, untyped,
 * zero-byte "file" is taken for a folder.
 */
export function droppedFiles(dataTransfer) {
  const files = [...(dataTransfer?.files ?? [])];
  const items = [...(dataTransfer?.items ?? [])].filter((item) => item.kind === "file");
  if (items.length === files.length && items.every((item) => typeof item.webkitGetAsEntry === "function")) {
    return files.filter((_file, i) => !items[i].webkitGetAsEntry()?.isDirectory);
  }
  return files.filter((file) => !(file.size === 0 && file.type === ""));
}

/**
 * `sendFiles(fileList)` for one conversation: the picker, paste and drop all come here. Each file becomes its own
 * message, in order. Where sending is not allowed (`block`, the hold) the hold notice is shown and nothing is
 * uploaded; a file over the size limit is refused here, before any request.
 */
export function useSendFiles(conv, block) {
  const { dispatch, actions } = useStore();
  return useCallback(
    (list) => {
      const files = [...list];
      if (files.length === 0) return;
      if (block) {
        dispatch({ type: "toast", text: block.text });
        return;
      }
      const tooBig = files.filter((file) => file.size > MAX_FILE_BYTES);
      if (tooBig.length > 0) {
        const text = tooBig.length === 1 ? `「${tooBig[0].name}」超过 ${FILE_LIMIT_TEXT}，无法发送` : `${tooBig.length} 个文件超过 ${FILE_LIMIT_TEXT}，无法发送`;
        dispatch({ type: "toast", text });
      }
      for (const file of files) if (file.size <= MAX_FILE_BYTES) actions.sendFile(conv.id, file);
    },
    [conv.id, block, actions, dispatch],
  );
}
