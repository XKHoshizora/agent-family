export type Mode = "parallel" | "discuss" | "single";
export type Role = "owner" | "admin" | "member" | "viewer";
export type Agent = {
  id: string;
  name: string;
  model: string;
  provider: string;
  persona: string;
  color: string;
  enabled: boolean;
  tools: boolean;
};
export type Room = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  mode: Mode;
  agents: Agent[];
  createdBy: string;
  visibility: "team" | "private";
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lineLinked?: boolean;
  projectMode: "off" | "shared" | "independent";
};
export type ProjectFile = {
  path: string;
  content: string | null;
  version: number;
  branch: string;
  updatedAt: string;
  updatedBy: string;
};
export type FileChange = {
  path: string;
  content: string | null;
  baseVersion: number;
  beforeContent?: string | null;
};
export type ChangeSet = {
  id: string;
  roomId: string;
  branch: string;
  agentId: string;
  runId: string | null;
  title: string;
  status: "pending" | "approved" | "rejected";
  files: FileChange[];
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
};
export type Message = {
  id: string;
  roomId: string;
  runId: string | null;
  role: "user" | "assistant" | "system";
  agentId: string | null;
  author: string;
  model: string | null;
  content: string;
  status: "complete" | "streaming" | "error" | "cancelled";
  reasoning?: string;
  source: "web" | "line";
  createdAt: string;
  tokens: number;
  toolEvents: ToolEvent[];
};
export type ToolEvent = { name: string; label: string; result?: string };
export type Run = {
  id: string;
  roomId: string;
  status: string;
  mode: Mode;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
};
export type Note = {
  id: string;
  roomId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type ModelOption = {
  id: string;
  provider: string;
  label: string;
  family: string;
};
export type UserSession = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; role: Role };
};
export const MODE_LABELS: Record<Mode, string> = {
  parallel: "大家分别说",
  discuss: "一起讨论",
  single: "一位伙伴回答",
};
export const COLORS = ["sage", "clay", "blue", "violet", "gold"];
export const DEFAULT_AGENTS: Agent[] = [
  {
    id: "gpt",
    name: "小智",
    model: "",
    provider: "canal",
    persona:
      "你善于理清思路和拆解问题。用清楚、实用的语言给出建议，保持自己的判断。",
    color: "sage",
    enabled: true,
    tools: false,
  },
  {
    id: "claude",
    name: "小文",
    model: "",
    provider: "canal",
    persona:
      "你善于表达、写作与审慎分析。关注细节和人的感受，提出有帮助的不同观点。",
    color: "clay",
    enabled: true,
    tools: false,
  },
  {
    id: "gemini",
    name: "小研",
    model: "",
    provider: "canal",
    persona:
      "你善于探索、研究与比较选择。从不同角度思考，明确区分事实、推测与不确定性。",
    color: "blue",
    enabled: true,
    tools: false,
  },
];
