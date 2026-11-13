import { addMessage, db, messageFrom } from "./db";
import type { Room } from "../shared/types";
import { normalizedContribution } from "./discussion";

// Conservative lexical similarity; changed quantities and negation remain meaningful.
export function similarContribution(a: string, b: string) {
  const x = normalizedContribution(a),
    y = normalizedContribution(b);
  if (!x || !y) return false;
  const facts = (s: string) =>
    JSON.stringify({
      numbers: [...s.matchAll(/\d+(?:\.\d+)?%?/g)].map((m) => m[0]),
      negatives: (s.match(/不|无|非|未|否|not|never|without/gi) || [])
        .map((s) => s.toLowerCase())
        .sort(),
    });
  if (facts(a) !== facts(b)) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 40) return false;
  const grams = (s: string) =>
    new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const gx = grams(x),
    gy = grams(y);
  const intersection = [...gx].filter((g) => gy.has(g)).length;
  return (2 * intersection) / (gx.size + gy.size) >= 0.84;
}

export function turnInstructions(summary: boolean, first: boolean) {
  if (summary)
    return `现在是最后的整理阶段，直接交付完整可执行方案，不再点名、提问伙伴或邀请复核，也不要使用工具。目标400–700中文字以内，用四个短小标题：目标与假设、最终方案、分歧与未完成、下一步。先给结论，保留关键计算和条件；区分已检查与待验证，不将未完成片段当作共识，不声称全员同意。存在关键歧义时清楚列出条件分支或待用户确认的选择，不擅自补齐。需要报价或资料时给出最小待填项和可用的条件方案；不要只有“请提供资料”。优先整理已被纠正和复核的结论，不重新从零穷举方案；核验计算的单位和数值，仍有矛盾时标记未解决。公式用可读的普通文本，不使用 LaTeX。`;
  return `这是协作接话，不是每人独立写一篇报告。先用一句回应最近的问题，再增加一个具体观点、纠正或计算，通常120–250中文字，最多约400字、六句话；复杂任务拆成小问题逐步处理，不要重写已出现的定义、清单、表格或整套方案。先给结论，避免展开穷举推导。计算先核验单位；固定成本、边际成本和收入不能混用，发现先前数字错误时明确更正。公式用普通文本，不使用 LaTeX。没有实质新内容用 discussion_turn 的 pass；目标已经解决且其他伙伴已经发言，用 finish 请求整理，不再制造新的复核问题。handoff 只提出一个小而明确的问题，正文与工具 question 不要各写一遍。看到 status=error/cancelled 的发言，明确它未完成，优先补齐其缺口，不假装已经读到完整意见。标有 paused 的伙伴已多次失败，暂不向其交棒。${first ? "首位先明确任务目标、交付物和用户视角。若买方/卖方、使用者/经营者等解释会根本改变方案，提出一个简短澄清问题并用 clarify 等待用户，不擅自选定一方后继续讨论；不影响方向的细节可标注假设后推进。" : "遵循用户已经明确的视角，不重复请求已经提供的信息。"}`;
}

export function saveFallback(
  room: Room,
  runId: string,
  reason: string,
  source: "web" | "line",
) {
  const messages = (
    db
      .prepare(
        "SELECT * FROM messages WHERE run_id=? AND role='assistant' ORDER BY rowid",
      )
      .all(runId) as any[]
  ).map(messageFrom);
  const complete = messages.filter(
    (m) => m.status === "complete" && m.content.trim(),
  );
  const failed = [
    ...new Set(
      messages.filter((m) => m.status !== "complete").map((m) => m.author),
    ),
  ];
  const excerpts = complete
    .slice(-3)
    .map(
      (m) =>
        `- ${m.author}（发言 ${m.discussion?.turn || m.round}，原文摘录，未统一复核）：${m.content.slice(0, 220)}${m.content.length > 220 ? "…" : ""}`,
    );
  const pending = db
    .prepare(
      "SELECT count(*) AS n FROM discussion_inputs WHERE run_id=? AND answered_by IS NULL",
    )
    .get(runId) as { n: number };
  const msg = addMessage({
    roomId: room.id,
    runId,
    role: "system",
    agentId: null,
    author: "讨论记录",
    model: null,
    status: "complete",
    source,
    content: `### 结束记录 · 尚无完整最终方案\n\n${reason}\n\n${excerpts.length ? "可供继续整理的片段：\n" + excerpts.join("\n") : "本次没有完整发言可供整理。"}\n\n未完成：${failed.length ? failed.join("、") + " 的部分发言未完成；" : ""}${pending.n ? pending.n + " 条用户补充仍待回应；" : ""}最终方案尚未完成，不能视作全员共识。\n\n下一步：查看已保留记录，确认待解决的问题后继续讨论。此结束记录未额外调用模型。`,
  });
  db.prepare("UPDATE messages SET discussion=? WHERE id=?").run(
    JSON.stringify({ phase: "fallback", turn: messages.length }),
    msg.id,
  );
}
