import { addMessage, db, messageFrom } from "./db";
import type { DiscussionReview, Room } from "../shared/types";
import { z } from "zod";
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

export const reviewSchema = z
  .object({
    checked: z
      .array(
        z.object({
          turn: z.number().int().positive(),
          quote: z.string().trim().min(1).max(180),
          check: z.string().trim().min(1).max(400),
        }),
      )
      .max(4),
    findings: z
      .array(
        z.object({
          turn: z.number().int().positive(),
          quote: z.string().trim().min(1).max(180),
          problem: z.string().trim().min(1).max(300),
          correction: z.string().trim().min(1).max(400),
        }),
      )
      .max(5),
    unresolved: z.array(z.string().trim().min(1).max(300)).max(6),
  })
  .refine(
    (v) => v.checked.length + v.findings.length > 0,
    "复核必须引用至少一条已有发言",
  );

// Attribution is checked mechanically; mathematical and semantic correctness are not.
export function validateReview(
  runId: string,
  reviewerTurn: number,
  value: DiscussionReview,
  reviewerAgentId: string,
) {
  const rows = (
    db
      .prepare("SELECT * FROM messages WHERE run_id=? AND role='assistant'")
      .all(runId) as any[]
  ).map(messageFrom);
  let citesPeer = false;
  for (const item of [...value.checked, ...value.findings]) {
    const source = rows.find(
      (m) => m.discussion?.turn === item.turn && item.turn < reviewerTurn,
    );
    if (!source || !source.content.includes(item.quote))
      throw new Error("复核引用必须来自本次已有发言的正式正文");
    if (source.agentId !== reviewerAgentId) citesPeer = true;
    const checked = value.checked.find((v) => v === item);
    if (checked) checked.incomplete = source.status !== "complete";
  }
  if (!citesPeer) throw new Error("交叉复核至少需要核对另一位伙伴的发言");
}

export function renderReview(review: DiscussionReview) {
  return [
    "### 交叉复核",
    ...review.checked.map(
      (v) =>
        `- 核对${v.incomplete ? "未完成发言" : "发言"} ${v.turn}${v.incomplete ? "的片段" : ""}「${v.quote}」：${v.check}${v.incomplete ? "（仅核对引用片段，原发言仍未完成。）" : ""}`,
    ),
    ...review.findings.map(
      (v) =>
        `- 修正发言 ${v.turn}「${v.quote}」：${v.problem}\n  建议修正：${v.correction}`,
    ),
    "### 尚未解决",
    ...(review.unresolved.length
      ? review.unresolved.map((v) => `- ${v}`)
      : ["- 本次复核未列出其他问题；这不等同于独立事实认证。"]),
  ].join("\n");
}

export function turnInstructions(
  phase: "discussion" | "review" | "summary",
  first: boolean,
) {
  if (phase === "review")
    return `现在是收尾前的交叉复核。不要再泛泛提问或附和，检查用户原始要求与最新补充，对照所有伙伴的方案，寻找反例并独立重算关键结果。必须调用 discussion_review 一次提交复核，界面将显示报告，不必另写重复正文。checked 与 findings 均用 turn 和逐字 quote 引用已有正式正文的一小段，不能引用思考或虚构发言；check 给出重算式、边界例子或可检验理由，不能仅写“正确/同意”。findings 明确原说法的问题和替代结论，不只说待核验。逐项检查：输入数据有无抄错；数值/单位/公式；需求是否遗漏；不同规则是否相互冲突；正常/极限情景能否跑通；前面提出的问题是否真的被回答。分清用量样例、预期与最坏情况保证。存在范围/分配歧义时可求上下界，不要无理由丢弃可算的范围。涉及失败、重试、扣款时明确谁承担费用及其对目标的影响。没有讨论过的规则不得凭空当作共识；缺失规则、仅由你新提出而未交叉核对的修正与决策写入 unresolved，明确影响和下一步验证。引用他人主要观点，避免只审查自己。`;
  if (phase === "summary")
    return `现在是最后的整理阶段，不再点名、提问伙伴或邀请复核，也不要使用工具。用四个标题：目标与假设、最终方案、分歧与未完成、下一步。通常400–900中文字，以满足要求和说清边界优先。每个新增或更正的数字必须紧邻给出使用已知输入的简短算式；优先沿用已核验的数值，不补写未讨论且非交付所需的数字细节。分配问题逐项检查守恒：各类数量之和必须还原原始输入，各分项必须加回总额，费用、额度、日期分别核对。无法给出依据的数字不要放进可执行方案。计数、Token、人数、天数等离散量必须能按整数执行；不要以无法落地的分数计数或逐笔舍入替代守恒。用户已明确的规则直接采用，不要重复索取确认或自行把已确定项变成阻塞；只有实际缺失或相互冲突的条件才待确认。用户明确的硬约束（例如自然月末、最多5分钟）不得自行替换为更方便的条件；备选项只能列为待确认。先对照交叉复核报告逐项处理修正和未解决项，明确原说法→采用的修正及理由；不能仅重复之前的数字。最终方案只能收录本次已经讨论且有依据的规则，不得临时新增额度池、定价、权限、期限、责任分配等政策。需要新规则才能闭环的部分放在“分歧与未完成”，明确不可执行的范围、待谁确认什么；不把新增建议混入执行步骤后再用一句“未复核”免责。复核中首次提出的修正需你重新计算/用例检查后才能采纳，无法验证就保留为阻塞项。覆盖用户每项交付要求，缺项逐项点明，不能以无关限制替代所要功能；未完成不得声称完整可上线。给出正常和边界用例、顺序明确的执行步骤、负责角色和验收标准；若主任务受阻则交付可执行子集并明确“待确认草案”。区分计算成立、模型互查和真实运行验证；没有交叉复核时主动写明，不声称达成共识。检查费用、额度、有效期、并发等规则是否同时成立，不能用平均/假设数据声称硬上限保证。公式用普通文本。`;
  return `这是协作接话，不是每人独立写一篇报告。必须先实质回答向你的现有问题，再增加一个具体观点、纠正或计算；不能跳过回答只把问题转发。若只调用交棒工具，请在 contribution 字段写出回答，question 只写后续问题。用户要设计方案时，基于已给数据提出有理由的具体选择；不要凭空加入用户没有要求的新费率或扩展支线，不要把可自行完成的计算与设计全部推回用户，通常120–250中文字，最多约400字、六句话；复杂任务拆成小问题逐步处理，不要重写已出现的定义、清单、表格或整套方案。先给结论，避免展开穷举推导。优先补齐尚未交付的要求并检查相互兼容；不要反复核对已经明确的基础数字而不推进方案。计算先核验单位；固定成本、边际成本和收入不能混用，发现先前数字错误时明确更正。公式用普通文本，不使用 LaTeX。没有实质新内容用 discussion_turn 的 pass；目标已经解决且其他伙伴已经发言，用 finish 请求整理，不再制造新的复核问题。handoff 只提出一个小而明确的问题，正文与工具 question 不要各写一遍。看到 status=error/cancelled 的发言，明确它未完成，优先补齐其缺口，不假装已经读到完整意见。标有 paused 的伙伴已多次失败，暂不向其交棒。${first ? "首位先明确任务目标、交付物和用户视角。若买方/卖方、使用者/经营者等解释会根本改变方案，提出一个简短澄清问题并用 clarify 等待用户，不擅自选定一方后继续讨论；不影响方向的细节可标注假设后推进。" : "遵循用户已经明确的视角，不重复请求已经提供的信息。"}`;
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
