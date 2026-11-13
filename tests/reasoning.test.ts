import { describe, expect, it } from "vitest";
import { splitReasoning } from "../shared/reasoning";

describe("explicit reasoning separation", () => {
  it("separates leading blocks without summarizing or inventing content", () => {
    expect(splitReasoning("<think>实际思考</think>正式回答")).toEqual({
      content: "正式回答",
      reasoning: "实际思考",
    });
    expect(
      splitReasoning(
        "<THINKING>思考一</THINKING>\n<think>思考二</think>\n回答",
      ),
    ).toEqual({ content: "回答", reasoning: "思考一\n\n思考二" });
    expect(splitReasoning("没有公开思考的回答")).toEqual({
      content: "没有公开思考的回答",
      reasoning: "",
    });
  });
  it("does not flash partial delimiters or thoughts at any streaming boundary", () => {
    const text = "<think>private reasoning</think>Public answer";
    const answerStart = text.indexOf("Public");
    for (let end = 1; end <= text.length; end++) {
      const parts = splitReasoning(text.slice(0, end), true);
      expect(parts.content).toBe(
        end < answerStart ? "" : text.slice(answerStart, end).trim(),
      );
      expect(parts.reasoning).not.toContain("</");
    }
    expect(splitReasoning("<thinking>仍在思考", true)).toEqual({
      content: "",
      reasoning: "仍在思考",
    });
  });
  it("preserves fenced, inline, escaped and quoted tag examples", () => {
    for (const text of [
      "```html\n<think>example</think>\n```",
      "~~~xml\n<thinking>example</thinking>\n~~~",
      "`<think>example</think>`",
      "\\<think>example</think>",
      "> <think>example</think>",
      "标签 <think> 是一个示例",
      "<thinker>normal HTML</thinker>",
    ])
      expect(splitReasoning(text)).toEqual({ content: text, reasoning: "" });
  });
  it("retains code examples following an actual reasoning block", () => {
    const code = "```xml\n<think>sample</think>\n```";
    expect(splitReasoning(`<think>prepare code</think>\n${code}`)).toEqual({
      content: code,
      reasoning: "prepare code",
    });
  });
  it("handles a long thought and a completed literal partial tag", () => {
    expect(
      splitReasoning(`<think>${"a".repeat(49000)}</think>done`).content,
    ).toBe("done");
    expect(splitReasoning("<thi").content).toBe("<thi");
  });
});
