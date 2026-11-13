import { useState } from "react";
import type { DiscussionSettings, Run } from "../shared/types";
import { Modal, Field, ErrorBox } from "./components";
import { patch } from "./api";

export function DiscussionFields({
  value,
  onChange,
}: {
  value: DiscussionSettings;
  onChange: (v: DiscussionSettings) => void;
}) {
  return (
    <div className="discussion-fields">
      <label className="check-field">
        <input
          type="checkbox"
          checked={value.maxRounds === null}
          onChange={(e) =>
            onChange({ ...value, maxRounds: e.target.checked ? null : 3 })
          }
        />
        不限轮数
      </label>
      <div className="discussion-numbers">
        <Field label="最多讨论轮数">
          <input
            type="number"
            min={1}
            max={10000}
            disabled={value.maxRounds === null}
            value={value.maxRounds ?? ""}
            placeholder="无限制"
            onChange={(e) =>
              onChange({ ...value, maxRounds: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="本次模型调用上限">
          <input
            type="number"
            min={1}
            max={100000}
            value={value.maxCalls}
            onChange={(e) =>
              onChange({ ...value, maxCalls: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={value.stopWhenQuiet}
          onChange={(e) =>
            onChange({ ...value, stopWhenQuiet: e.target.checked })
          }
        />
        所有伙伴暂无补充时结束
      </label>
      <p className="hint">
        一轮按参与人数次发言计算。不限轮数仍受本次及每日额度约束；连续三次重复或失败会停止。每次发言按需预留额度，未用释放。
      </p>
    </div>
  );
}
export function DiscussionEditor({
  run,
  roomId,
  onClose,
  onSaved,
}: {
  run: Run;
  roomId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(run.discussion!);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="调整自由讨论"
      description="修改在下一次发言或模型调用前生效，已发送的请求不会追回。"
    >
      <p>
        已发言 {run.turns || 0} 次 · 已调用 {run.callsUsed || 0} 次
      </p>
      <DiscussionFields value={value} onChange={setValue} />
      <ErrorBox error={error} />
      <button
        className="button primary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await patch(`/api/rooms/${roomId}/discussion`, {
              runId: run.id,
              settings: value,
            });
            onSaved();
            onClose();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        应用到当前讨论
      </button>
    </Modal>
  );
}
