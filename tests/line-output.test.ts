import { describe, expect, it } from "vitest";
import { lineMessages } from "../server/line-output";
import type { Message, Run } from "../shared/types";
const message = (
  agent: number,
  round: number,
  status: Message["status"] = "complete",
): Message => ({
  id: `${agent}-${round}`,
  roomId: "r",
  runId: "run",
  role: "assistant",
  agentId: String(agent),
  author: `伙伴${agent}`,
  model: "mock",
  content: `R${round}-A${agent}`,
  round,
  status,
  source: "line",
  createdAt: "",
  tokens: 0,
  toolEvents: [],
});
describe("LINE final-round delivery", () => {
  it.each([2, 3, 4, 5])(
    "sends only complete second-round answers for %i members",
    (count) => {
      const messages = [1, 2].flatMap((round) =>
        Array.from({ length: count }, (_, i) => message(i, round)),
      );
      const result = lineMessages(messages);
      expect(result).toHaveLength(count);
      expect(JSON.stringify(result)).not.toContain("R1-");
      expect(result.every((m) => m.text.startsWith("第 2 轮"))).toBe(true);
    },
  );
  it.each([0, 1, 2, 3, 4])(
    "separates errors at position %i into a system notice",
    (position) => {
      const messages = [1, 2].flatMap((round) =>
        Array.from({ length: 5 }, (_, i) =>
          message(
            i,
            round,
            round === 2 && i === position ? "error" : "complete",
          ),
        ),
      );
      const result = lineMessages(messages);
      expect(result.length).toBeLessThanOrEqual(5);
      expect(result[0].sender).toBeUndefined();
      expect(result[0].text).toContain(`伙伴${position}`);
      expect(JSON.stringify(result)).not.toContain(`R2-A${position}`);
      expect(JSON.stringify(result)).not.toContain("R1-");
    },
  );
  it("never substitutes first-round text when the latest round was cancelled or failed", () => {
    const result = lineMessages(
      [
        message(0, 1),
        message(1, 1),
        message(0, 2, "cancelled"),
        message(1, 2, "error"),
      ],
      { status: "cancelled" } as Run,
    );
    expect(result).toHaveLength(1);
    expect(result[0].sender).toBeUndefined();
    expect(result[0].text).toContain("已停止");
    expect(JSON.stringify(result)).not.toMatch(/R[12]-/);
  });
});
