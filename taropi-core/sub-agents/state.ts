import type {
  AgentRunLogEntry,
  AgentRunStatus,
  AgentToolCallState,
  SubagentRunState,
  UsageStats,
} from "./types.ts";

const MAX_LOG_ENTRIES = 200;
const MAX_LOG_TEXT_LENGTH = 4_000;
const MAX_STREAM_TEXT_LENGTH = 8_000;
const MAX_TOOL_CALLS = 50;
const MAX_TOOL_VALUE_LENGTH = 8_000;

const emptyUsage = (): UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

const runs = new Map<string, SubagentRunState>();
let logSequence = 0;

// limitText 限制面板状态中保存的文本长度，避免长任务持续占用内存。
function limitText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `…${text.slice(-(maxLength - 1))}`;
}

// limitStoredValue 限制工具参数和结果本身，不能只限制展示日志，否则状态仍会无限增长。
function limitStoredValue(value: unknown, maxLength = MAX_TOOL_VALUE_LENGTH): unknown {
  if (typeof value === "string") return limitText(value, maxLength);
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maxLength ? value : limitText(serialized, maxLength);
  } catch {
    return limitText(String(value), maxLength);
  }
}

// summarizeValue 将工具参数和结果压缩为适合 TUI 展示的文本。
export function summarizeValue(value: unknown, maxLength = 500): string {
  if (value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return limitText(text.replace(/\s+/g, " ").trim(), maxLength);
}

// startRun 注册一条新的子 Agent 运行记录，并返回其稳定 runId。
export function startRun(input: {
  runId: string;
  name: string;
  task: string;
  agentSource: "user" | "project" | "unknown";
  actualModel: string;
  model?: string;
  step?: number;
  startTime?: number;
}): SubagentRunState {
  const state: SubagentRunState = {
    runId: input.runId,
    name: input.name,
    task: input.task,
    agentSource: input.agentSource,
    step: input.step,
    startTime: input.startTime ?? Date.now(),
    actualModel: input.actualModel,
    model: input.model,
    latestTool: "",
    tokens: { input: 0, output: 0 },
    usage: emptyUsage(),
    status: "running",
    streamText: "",
    toolCalls: [],
    logs: [],
  };
  runs.set(input.runId, state);
  appendRunLog(input.runId, "status", "started");
  return state;
}

// getRun 按 runId 读取单个子 Agent 的实时状态。
export function getRun(runId: string | undefined): SubagentRunState | undefined {
  return runId ? runs.get(runId) : undefined;
}

// getActiveRuns 按开始时间升序返回当前会话中记录的运行状态。
export function getActiveRuns(): SubagentRunState[] {
  return Array.from(runs.values()).sort((a, b) => a.startTime - b.startTime);
}

// getSubAgentStates 兼容旧消费者对运行状态列表的引用。
export const getSubAgentStates = getActiveRuns;

// updateRun 更新一条子 Agent 的可变状态。
export function updateRun(
  runId: string,
  partial: {
    latestTool?: string;
    usage?: UsageStats;
    streamText?: string;
    errorMessage?: string;
  },
): void {
  const run = runs.get(runId);
  if (!run) return;
  if (partial.latestTool !== undefined) run.latestTool = partial.latestTool;
  if (partial.usage) {
    run.usage = { ...partial.usage };
    run.tokens = { input: partial.usage.input, output: partial.usage.output };
  }
  if (partial.streamText !== undefined) run.streamText = limitText(partial.streamText, MAX_STREAM_TEXT_LENGTH);
  if (partial.errorMessage !== undefined) run.errorMessage = limitText(partial.errorMessage, MAX_LOG_TEXT_LENGTH);
}

// appendRunLog 追加一条有限长度的运行动态。
export function appendRunLog(
  runId: string,
  type: AgentRunLogEntry["type"],
  text: string,
  metadata?: Pick<AgentRunLogEntry, "toolCallId" | "toolName">,
): void {
  const run = runs.get(runId);
  if (!run) return;
  run.logs.push({
    id: ++logSequence,
    timestamp: Date.now(),
    type,
    text: limitText(text, MAX_LOG_TEXT_LENGTH),
    ...metadata,
  });
  if (run.logs.length > MAX_LOG_ENTRIES) run.logs.splice(0, run.logs.length - MAX_LOG_ENTRIES);
}

// startToolCall 登记一条工具调用及其初始状态。
export function startToolCall(
  runId: string,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  const run = runs.get(runId);
  if (!run) return;
  const storedArgs = limitStoredValue(args);
  const tool: AgentToolCallState = {
    toolCallId,
    name,
    args:
      storedArgs && typeof storedArgs === "object" && !Array.isArray(storedArgs)
        ? (storedArgs as Record<string, unknown>)
        : { value: storedArgs },
    status: "running",
    startTime: Date.now(),
  };
  run.toolCalls.push(tool);
  if (run.toolCalls.length > MAX_TOOL_CALLS) run.toolCalls.splice(0, run.toolCalls.length - MAX_TOOL_CALLS);
  run.latestTool = name;
  appendRunLog(runId, "tool", `→ ${name}${summarizeValue(args) ? ` ${summarizeValue(args)}` : ""}`, {
    toolCallId,
    toolName: name,
  });
}

// updateToolCall 更新工具的流式结果或最终状态。
export function updateToolCall(
  runId: string,
  toolCallId: string,
  partial: Partial<Pick<AgentToolCallState, "status" | "partialResult" | "result" | "isError" | "endTime">>,
): void {
  const run = runs.get(runId);
  if (!run) return;
  const tool = run.toolCalls.find((item) => item.toolCallId === toolCallId);
  if (!tool) return;
  const storedPartial =
    partial.partialResult === undefined ? undefined : limitStoredValue(partial.partialResult);
  const storedResult = partial.result === undefined ? undefined : limitStoredValue(partial.result);
  Object.assign(tool, {
    ...partial,
    ...(storedPartial === undefined ? {} : { partialResult: storedPartial }),
    ...(storedResult === undefined ? {} : { result: storedResult }),
  });
  if (storedPartial !== undefined) {
    const text = `… ${tool.name}: ${summarizeValue(storedPartial)}`;
    const latestLog = run.logs[run.logs.length - 1];
    // 工具流式输出可能非常密集：同一调用只原地更新最后一条动态，不为每个 chunk 占一行。
    if (latestLog?.type === "tool" && latestLog.toolCallId === toolCallId && latestLog.text.startsWith("… ")) {
      latestLog.timestamp = Date.now();
      latestLog.text = limitText(text, MAX_LOG_TEXT_LENGTH);
    } else {
      appendRunLog(runId, "tool", text, { toolCallId, toolName: tool.name });
    }
  }
  if (partial.status === "completed" || partial.status === "error") {
    const result = storedResult === undefined ? "" : `: ${summarizeValue(storedResult)}`;
    appendRunLog(runId, partial.status === "error" ? "error" : "tool", `${partial.status === "error" ? "✗" : "✓"} ${tool.name}${result}`, {
      toolCallId,
      toolName: tool.name,
    });
  }
}

// finishRun 标记运行结束并保留其动态，供全屏页面回看。
export function finishRun(runId: string, status: Exclude<AgentRunStatus, "running">, errorMessage?: string): void {
  const run = runs.get(runId);
  if (!run) return;
  run.status = status;
  run.endTime = Date.now();
  if (errorMessage) run.errorMessage = limitText(errorMessage, MAX_LOG_TEXT_LENGTH);
  appendRunLog(runId, status === "completed" ? "status" : "error", status);
}

// clearRun 清除指定运行记录。
export function clearRun(runId: string): void {
  runs.delete(runId);
}

// clearAllRuns 清空当前会话的全部子 Agent 运行记录。
export function clearAllRuns(): void {
  runs.clear();
}
