import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveModelAlias as resolveFromAliasStore } from "../model-alias/store.js";
import type { AgentConfig, OnUpdateCallback, SingleResult, SubagentDetails, UsageStats } from "./types.ts";
import {
  appendRunLog,
  finishRun,
  getRun,
  startRun,
  startToolCall,
  summarizeValue,
  updateRun,
  updateToolCall,
} from "./state.ts";
import { requestHudRefresh } from "../hud/registry.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const UPDATE_INTERVAL_MS = 80;
let pendingHudRefresh: ReturnType<typeof setTimeout> | undefined;

// scheduleHudRefresh 将所有并发 Agent 的高频事件合并为一次 HUD 重绘。
function scheduleHudRefresh(immediate = false): void {
  if (immediate) {
    if (pendingHudRefresh) clearTimeout(pendingHudRefresh);
    pendingHudRefresh = undefined;
    requestHudRefresh();
    return;
  }
  if (pendingHudRefresh) return;
  pendingHudRefresh = setTimeout(() => {
    pendingHudRefresh = undefined;
    requestHudRefresh();
  }, UPDATE_INTERVAL_MS);
  pendingHudRefresh.unref?.();
}

// truncateParallelOutput 限制并行任务最终摘要的字节数，避免工具结果撑爆上下文。
export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

// mapWithConcurrencyLimit 按指定并发度处理数组，并保持结果顺序。
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// writePromptToTempFile 将子 Agent system prompt 写入权限受限的临时文件。
export async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

// resolveModelAlias 先查模型别名，再尝试按 models.json 展示名反查实际模型 ID。
function resolveModelAlias(modelName: string): string {
  const aliasResult = resolveFromAliasStore(modelName);
  if (aliasResult) return aliasResult;

  try {
    const modelsPath = path.join(getAgentDir(), "models.json");
    const content = fs.readFileSync(modelsPath, "utf-8");
    const config = JSON.parse(content) as {
      providers?: Record<string, { models?: Array<{ id: string; name?: string }> }>;
    };
    for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (model.name === modelName) return `${providerId}/${model.id}`;
      }
    }
  } catch {
    // 无模型配置时按原样传递给 pi。
  }
  return modelName;
}

// getPiInvocation 根据当前运行时选择可复用的 pi 启动命令。
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

// getFinalOutput 返回最后一条 assistant 文本输出。
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

// getAssistantText 提取一条 assistant 消息中已累计的文本内容。
function getAssistantText(message: unknown): string {
  const candidate = message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (candidate?.role !== "assistant") return "";
  return (candidate.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

// updateUsage 将完整 assistant 消息中的 usage 累加到当前任务。
function updateUsage(result: SingleResult, message: Message): void {
  if (message.role !== "assistant") return;
  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

// cloneUsage 复制 usage，避免状态存储与运行结果共用可变对象。
function cloneUsage(usage: UsageStats): UsageStats {
  return { ...usage };
}

// runSingleAgent 启动一个隔离的 pi 子进程并持续推送其运行状态。
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((item) => item.name === agentName);
  const startTime = Date.now();
  const runId = randomUUID();

  if (!agent) {
    const available = agents.map((item) => `"${item.name}"`).join(", ") || "none";
    const errorMessage = `Unknown agent: "${agentName}". Available agents: ${available}.`;
    startRun({
      runId,
      name: agentName,
      task,
      agentSource: "unknown",
      actualModel: "unknown",
      step,
      startTime,
    });
    finishRun(runId, "error", errorMessage);
    scheduleHudRefresh(true);
    return {
      runId,
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
      startTime,
      errorMessage,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const resolvedModel = agent.model ? resolveModelAlias(agent.model) : undefined;
  if (resolvedModel) args.push("--model", resolvedModel);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  const currentResult: SingleResult = {
    runId,
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
    startTime,
  };

  startRun({
    runId,
    name: agentName,
    task,
    agentSource: agent.source,
    actualModel: resolvedModel ?? agent.model ?? "unknown",
    model: agent.model,
    step,
    startTime,
  });

  let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
  const dispatchUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: "text", text: getRun(runId)?.streamText || getFinalOutput(currentResult.messages) || "(running...)" }],
      details: makeDetails([{ ...currentResult, usage: cloneUsage(currentResult.usage) }]),
    });
  };
  const emitUpdate = (immediate = false) => {
    if (!onUpdate) return;
    if (immediate) {
      if (pendingUpdate) clearTimeout(pendingUpdate);
      pendingUpdate = undefined;
      dispatchUpdate();
      return;
    }
    if (!pendingUpdate) {
      pendingUpdate = setTimeout(() => {
        pendingUpdate = undefined;
        dispatchUpdate();
      }, UPDATE_INTERVAL_MS);
    }
  };
  const refreshRun = () => {
    updateRun(runId, { usage: currentResult.usage });
    scheduleHudRefresh();
    emitUpdate();
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        switch (event.type) {
          case "message_start":
            if (event.message?.role === "assistant") updateRun(runId, { streamText: "" });
            break;
          case "message_update": {
            const streamText = getAssistantText(event.message);
            if (streamText) updateRun(runId, { streamText });
            scheduleHudRefresh();
            emitUpdate();
            break;
          }
          case "message_end": {
            if (!event.message) break;
            const message = event.message as Message;
            currentResult.messages.push(message);
            updateUsage(currentResult, message);
            const text = getAssistantText(message);
            if (text) {
              updateRun(runId, { streamText: "" });
              appendRunLog(runId, "message", text);
            }
            refreshRun();
            break;
          }
          case "tool_execution_start": {
            if (event.toolCallId && event.toolName) {
              startToolCall(runId, event.toolCallId, event.toolName, event.args ?? {});
              refreshRun();
            }
            break;
          }
          case "tool_execution_update": {
            if (event.toolCallId) {
              updateToolCall(runId, event.toolCallId, { partialResult: event.partialResult });
              refreshRun();
            }
            break;
          }
          case "tool_execution_end": {
            if (event.toolCallId) {
              updateToolCall(runId, event.toolCallId, {
                status: event.isError ? "error" : "completed",
                result: event.result,
                isError: Boolean(event.isError),
                endTime: Date.now(),
              });
              refreshRun();
            }
            break;
          }
          case "tool_result_end": {
            if (event.message) {
              currentResult.messages.push(event.message as Message);
              appendRunLog(runId, "tool", `tool result: ${summarizeValue(event.message)}`);
              refreshRun();
            }
            break;
          }
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", (error) => {
        currentResult.errorMessage ??= error.message;
        currentResult.stderr += `${currentResult.stderr ? "\n" : ""}${error.message}`;
        resolve(1);
      });

      if (signal) {
        const killProcess = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProcess();
        else signal.addEventListener("abort", killProcess, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) {
      currentResult.stopReason = "aborted";
      finishRun(runId, "aborted", "Subagent was aborted");
      emitUpdate(true);
      scheduleHudRefresh(true);
      throw new Error("Subagent was aborted");
    }
    const status = currentResult.exitCode === 0 ? "completed" : "error";
    finishRun(runId, status, currentResult.errorMessage || currentResult.stderr || undefined);
    emitUpdate(true);
    scheduleHudRefresh(true);
    return currentResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (currentResult.exitCode === -1) currentResult.exitCode = 1;
    currentResult.errorMessage ??= errorMessage;
    if (getRun(runId)?.status === "running") {
      finishRun(runId, "error", currentResult.errorMessage);
      scheduleHudRefresh(true);
      emitUpdate(true);
    }
    throw error;
  } finally {
    if (pendingUpdate) clearTimeout(pendingUpdate);
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        // 临时文件已被清理时无需处理。
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        // 临时目录已被清理时无需处理。
      }
  }
}
