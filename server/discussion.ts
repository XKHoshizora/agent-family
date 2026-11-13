import { z } from "zod";
import { db } from "./db";
import {
  DEFAULT_DISCUSSION,
  type Agent,
  type DiscussionSettings,
} from "../shared/types";

export const discussionSchema = z.object({
  maxRounds: z.number().int().min(1).max(10000).nullable(),
  maxCalls: z.number().int().min(1).max(100000),
  stopWhenQuiet: z.boolean(),
});
export const turnSchema = z
  .object({
    action: z.enum(["handoff", "continue", "pass", "clarify", "finish"]),
    nextAgentId: z.string().max(100).optional(),
    question: z.string().max(1000).optional(),
    contribution: z.string().max(4000).optional(),
  })
  .refine((v) => v.action !== "clarify" || !!v.question?.trim(), {
    message: "向用户澄清时必须提供明确问题。",
  });
export type TurnDecision = z.infer<typeof turnSchema>;
export function discussionSettings(value?: unknown): DiscussionSettings {
  return discussionSchema.parse(value ?? DEFAULT_DISCUSSION);
}
export function updateDiscussion(
  runId: string,
  roomId: string,
  value: unknown,
) {
  const settings = discussionSettings(value);
  const result = db
    .prepare(
      "UPDATE runs SET discussion=? WHERE id=? AND room_id=? AND mode='free' AND status IN ('queued','running')",
    )
    .run(JSON.stringify(settings), runId, roomId);
  if (!result.changes) throw new Error("这次自由讨论已经结束或不存在。");
  return settings;
}
export function nextSpeaker(
  agents: Agent[],
  lastSpoke: Map<string, number>,
  turn: number,
  requested?: string,
) {
  const oldest = [...agents].sort(
    (a, b) => (lastSpoke.get(a.id) ?? 0) - (lastSpoke.get(b.id) ?? 0),
  )[0];
  if (turn - (lastSpoke.get(oldest.id) ?? 0) >= agents.length) return oldest;
  return agents.find((a) => a.id === requested) || oldest;
}
export function normalizedContribution(text: string) {
  return text
    .replace(/@[\p{L}\p{N}_-]+/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}
