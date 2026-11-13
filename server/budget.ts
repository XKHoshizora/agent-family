import { db } from "./db";
import { config, now } from "./config";

export function usage(workspaceId: string, day = now().slice(0, 10)) {
  const row = db
    .prepare("SELECT * FROM usage_daily WHERE workspace_id=? AND day=?")
    .get(workspaceId, day) as any;
  return {
    calls: row?.calls || 0,
    tokens: row?.tokens || 0,
    reserved: row?.reserved || 0,
    lineCalls: row?.line_calls || 0,
    lineReserved: row?.line_reserved || 0,
    limit: config.dailyCalls,
    lineLimit: Math.min(config.dailyCalls, config.dailyLineCalls),
    day,
  };
}
function ensureDay(workspaceId: string, day: string) {
  db.prepare(
    "INSERT OR IGNORE INTO usage_daily(workspace_id,day,calls,tokens) VALUES(?,?,0,0)",
  ).run(workspaceId, day);
}
export function reserveRunBudget(
  runId: string,
  workspaceId: string,
  amount: number,
  source: "web" | "line",
) {
  db.transaction(() => {
    const u = usage(workspaceId);
    if (
      !Number.isInteger(amount) ||
      amount < 1 ||
      u.calls + u.reserved + amount > u.limit
    )
      throw new Error(
        `今日剩余次数不足，需预留最多 ${amount} 次模型调用；未使用部分会释放。`,
      );
    if (
      source === "line" &&
      u.lineCalls + u.lineReserved + amount > u.lineLimit
    )
      throw new Error("LINE 今日剩余额度不足，请减少伙伴或稍后再试。");
    ensureDay(workspaceId, u.day);
    db.prepare("INSERT INTO run_budgets VALUES(?,?,?,?,?)").run(
      runId,
      workspaceId,
      u.day,
      source,
      amount,
    );
    db.prepare(
      "UPDATE usage_daily SET reserved=reserved+?,line_reserved=line_reserved+? WHERE workspace_id=? AND day=?",
    ).run(amount, source === "line" ? amount : 0, workspaceId, u.day);
  })();
}
export function consumeRunBudget(runId: string) {
  return db.transaction(() => {
    const b = db
      .prepare("SELECT * FROM run_budgets WHERE run_id=?")
      .get(runId) as any;
    if (!b || b.remaining < 1) throw new Error("本次预留额度已用尽。");
    db.prepare(
      "UPDATE run_budgets SET remaining=remaining-1 WHERE run_id=?",
    ).run(runId);
    const line = b.source === "line" ? 1 : 0;
    db.prepare(
      "UPDATE usage_daily SET calls=calls+1,reserved=reserved-1,line_calls=line_calls+?,line_reserved=line_reserved-? WHERE workspace_id=? AND day=?",
    ).run(line, line, b.workspace_id, b.day);
    return b.day as string;
  })();
}
export function releaseRunBudget(runId: string) {
  db.transaction(() => {
    const b = db
      .prepare("SELECT * FROM run_budgets WHERE run_id=?")
      .get(runId) as any;
    if (!b) return;
    db.prepare(
      "UPDATE usage_daily SET reserved=reserved-?,line_reserved=line_reserved-? WHERE workspace_id=? AND day=?",
    ).run(
      b.remaining,
      b.source === "line" ? b.remaining : 0,
      b.workspace_id,
      b.day,
    );
    db.prepare("DELETE FROM run_budgets WHERE run_id=?").run(runId);
  })();
}
export function recoverBudgets() {
  db.transaction(() => {
    for (const b of db.prepare("SELECT run_id FROM run_budgets").all() as any[])
      releaseRunBudget(b.run_id);
  })();
}
// For non-run administrative probes; cannot consume another task's reservation.
export function reserveCall(workspaceId: string) {
  return db.transaction(() => {
    const u = usage(workspaceId);
    if (u.calls + u.reserved >= u.limit)
      throw new Error("今日的 AI 使用次数已达上限。");
    ensureDay(workspaceId, u.day);
    db.prepare(
      "UPDATE usage_daily SET calls=calls+1 WHERE workspace_id=? AND day=?",
    ).run(workspaceId, u.day);
    return u.day;
  })();
}
