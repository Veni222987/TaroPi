import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** 子 Agent 运行的生命周期状态。 */
export type AgentRunStatus = "running" | "completed" | "error" | "aborted";

/** 单次工具调用的实时状态。工具参数、过程结果和最终结果均经过容量限制。 */
export interface AgentToolCallState {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "error";
  startTime: number;
  endTime?: number;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

/** 供紧凑面板和全屏页消费的一条运行动态。 */
export interface AgentRunLogEntry {
  id: number;
  timestamp: number;
  type: "message" | "tool" | "status" | "error";
  text: string;
  toolCallId?: string;
  toolName?: string;
}

/**
 * 单次子 Agent 执行的统一运行模型。
 *
 * `runId` 是跨面板、工具结果和流式事件关联的唯一键；不得使用 `name` 关联，
 * 因为同名 Agent 可以并发执行。
 */
export interface SubagentRunState {
  runId: string;
  name: string;
  task: string;
  agentSource: "user" | "project" | "unknown";
  step?: number;
  startTime: number;
  endTime?: number;
  /** 别名解析后的实际模型 ID。 */
  actualModel: string;
  /** Agent 配置中的模型名，未配置时为空。 */
  model?: string;
  /** 最近一次工具调用名，无调用时为空串。 */
  latestTool: string;
  /** 兼容旧 HUD 的输入/输出 Token 视图。 */
  tokens: { input: number; output: number };
  /** 累计 Token、成本和轮次。 */
  usage: UsageStats;
  status: AgentRunStatus;
  /** 当前 assistant 消息的流式文本，保留末尾的有限内容。 */
  streamText: string;
  toolCalls: AgentToolCallState[];
  logs: AgentRunLogEntry[];
  errorMessage?: string;
}

export interface SingleResult {
  /** 实际执行时始终存在；并行面板的未启动占位项可能暂未分配。 */
  runId?: string;
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  /** 子进程启动时间戳 */
  startTime?: number;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
