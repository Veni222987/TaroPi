import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveModelAlias as resolveFromAliasStore } from "../model-alias/store.js";
import type { AgentConfig, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.ts";
import { startRun, updateRun, finishRun } from "./state.ts";
import { requestHudRefresh } from "../hud/registry.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

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

// resolveModelAlias 先查 model-aliases.json 别名, 再查 models.json name 反查，找不到则原样返回
function resolveModelAlias(modelName: string): string {
  // 1) 先查 model-alias store (Au/Ag/Cu ↔ Aurum/Argentum/Cuprum)
  const aliasResult = resolveFromAliasStore(modelName);
  if (aliasResult) return aliasResult;

  // 2) 再查 models.json 的 name 字段反向匹配
  try {
    const modelsPath = path.join(getAgentDir(), "models.json");
    const content = fs.readFileSync(modelsPath, "utf-8");
    const config = JSON.parse(content) as {
      providers?: Record<string, { models?: Array<{ id: string; name?: string }> }>;
    };
    for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (model.name === modelName) {
          return `${providerId}/${model.id}`;
        }
      }
    }
  } catch {
    // 读取失败则继续
  }
  return modelName;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

// ── 状态辅助 ──

function extractLatestTool(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.toolName) return msg.toolName;
    if (msg.name && msg.role === "tool") return msg.name;
  }
  return null;
}

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
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
      startTime: Date.now(),
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const resolvedModel = agent.model ? resolveModelAlias(agent.model) : undefined;
  if (resolvedModel) args.push("--model", resolvedModel);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  };

  // 记录运行时状态（HUD 面板 + 全屏视图用）
  const runKey = `${agentName}:${step ?? Date.now()}`;
  startRun(runKey, agentName, resolvedModel ?? agent.model ?? "unknown", step);

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
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
      // 创建新的进程
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
          case "message_end": {
            if (!event.message) break;
            const msg = event.message as Message;
            currentResult.messages.push(msg);

            if (msg.role === "assistant") {
              currentResult.usage.turns++;
              const u = msg.usage;
              if (u) {
                currentResult.usage.input += u.input || 0;
                currentResult.usage.output += u.output || 0;
                currentResult.usage.cacheRead += u.cacheRead || 0;
                currentResult.usage.cacheWrite += u.cacheWrite || 0;
                currentResult.usage.cost += u.cost?.total || 0;
                currentResult.usage.contextTokens = u.totalTokens || 0;
              }
              if (!currentResult.model && msg.model) currentResult.model = msg.model;
              if (msg.stopReason) currentResult.stopReason = msg.stopReason;
              if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
            }
            emitUpdate();

            // 更新 HUD 状态
            const latestTool = extractLatestTool(currentResult.messages);
            updateRun(runKey, {
              latestTool: latestTool ?? undefined,
              tokens: { ...currentResult.usage },
            });
            requestHudRefresh();
            break;
          }
          case "tool_result_end": {
            if (event.message) {
              currentResult.messages.push(event.message as Message);
              emitUpdate();

              const toolMsg = event.message as any;
              updateRun(runKey, {
                latestTool: toolMsg?.toolName ?? toolMsg?.name ?? undefined,
                tokens: { ...currentResult.usage },
              });
              requestHudRefresh();
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

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) {
      finishRun(runKey, "error");
      requestHudRefresh();
      throw new Error("Subagent was aborted");
    }
    finishRun(runKey, currentResult.exitCode === 0 ? "completed" : "error");
    requestHudRefresh();
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
