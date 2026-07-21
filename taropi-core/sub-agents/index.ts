/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Ctrl+Shift+M cycles subagent execution mode: single → parallel → chain.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  getFinalOutput,
  mapWithConcurrencyLimit,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  runSingleAgent,
  truncateParallelOutput,
} from "./engine.ts";
import type {
  AgentConfig,
  AgentScope,
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
} from "./types.ts";
import { discoverAgents } from "./agents.ts";
import {
  closeAgentPanel,
  isPanelActive,
  showAgentPanel,
  updateAgentPanel,
} from "./agent-panel.ts";
import { installPanelShortcutCompatibility } from "./shortcuts.ts";
import { clearAllRuns } from "./state.ts";
import { formatUsageStats, getResultOutput, isFailedResult } from "./render.ts";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// createPendingResult 为尚未收到首个流式事件的卡片创建占位运行结果。
function createPendingResult(
  agents: AgentConfig[],
  agentName: string,
  task: string,
  runId: string,
  step?: number,
): SingleResult {
  const agent = agents.find((item) => item.name === agentName);
  return {
    runId,
    agent: agentName,
    agentSource: agent?.source ?? "unknown",
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent?.model,
    startTime: Date.now(),
    step,
  };
}

// register 注册 subagent 工具、紧凑面板生命周期与相关快捷键。
export function register(pi: ExtensionAPI) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageAgentsDir = path.join(__dirname, "..", "plain", "agents");
  const userAgentsDir = path.join(getAgentDir(), "agents");

  pi.registerShortcut("ctrl+shift+\\", {
    description: "Close subagent panel",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || !isPanelActive()) return;
      closeAgentPanel(ctx);
    },
  });

  type ExecMode = "single" | "parallel" | "chain";
  const MODE_CYCLE: ExecMode[] = ["single", "parallel", "chain"];
  let currentModeIndex = 0;

  pi.registerShortcut("ctrl+shift+m", {
    description: "Cycle subagent execution mode",
    handler: async (ctx) => {
      currentModeIndex = (currentModeIndex + 1) % MODE_CYCLE.length;
      const mode = MODE_CYCLE[currentModeIndex]!;
      ctx.ui.setStatus("subagent-mode", `🔀 ${mode}`);
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // /reload、切换 session 或关闭面板时，详情页会同步释放焦点、原始输入监听器和刷新定时器。
    if (ctx.mode === "tui") closeAgentPanel(ctx);
    clearAllRuns();
  });

  pi.on("session_start", async (_event, ctx) => {
    installPanelShortcutCompatibility(ctx);
    try {
      fs.mkdirSync(userAgentsDir, { recursive: true });
      const files = fs.readdirSync(packageAgentsDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const src = path.join(packageAgentsDir, file);
        const dst = path.join(userAgentsDir, file);
        const srcStat = fs.statSync(src);
        const dstExists = fs.existsSync(dst);
        if (!dstExists || srcStat.mtimeMs > fs.statSync(dst).mtimeMs) {
          fs.copyFileSync(src, dst);
        }
      }
    } catch {
      // 静默降级
    }
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      `Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
      `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
    ].join(" "),
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });
      // toolCallId 是本次父工具调用的唯一值；面板以它分组，不能再用 agent 名。
      const panelExecutionId = `tool:${toolCallId}`;

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        showAgentPanel(ctx, panelExecutionId, [], "chain");

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const pending = createPendingResult(
            agents,
            step.agent,
            taskWithContext,
            `${panelExecutionId}:step:${i + 1}`,
            i + 1,
          );
          updateAgentPanel(panelExecutionId, [...results, pending], results.length);

          const chainUpdate: OnUpdateCallback = (partial) => {
            const currentResult = partial.details?.results[0];
            if (!currentResult) return;
            const allResults = [...results, currentResult];
            updateAgentPanel(panelExecutionId, allResults, allResults.length - 1);
            onUpdate?.({
              content: partial.content ?? [{ type: "text", text: "(running...)" }],
              details: makeDetails("chain")(allResults),
            });
          };

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);
          updateAgentPanel(panelExecutionId, [...results], results.length - 1);

          const isError = isFailedResult(result);
          if (isError) {
            const errorMsg = getResultOutput(result);
            return {
              content: [
                { type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            { type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" },
          ],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        const allResults = params.tasks.map((task, index) =>
          createPendingResult(agents, task.agent, task.task, `${panelExecutionId}:task:${index + 1}`),
        );

        showAgentPanel(ctx, panelExecutionId, allResults, "parallel");

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [
                { type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
              ],
              details: makeDetails("parallel")([...allResults]),
            });
          }
          updateAgentPanel(panelExecutionId, [...allResults]);
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            t.agent,
            t.task,
            t.cwd,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel"),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const output = truncateParallelOutput(getResultOutput(r));
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${output}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const pending = createPendingResult(agents, params.agent, params.task, `${panelExecutionId}:single`);
        showAgentPanel(ctx, panelExecutionId, [pending], "single");
        const singleUpdate: OnUpdateCallback = (partial) => {
          const currentResult = partial.details?.results[0];
          if (!currentResult) return;
          updateAgentPanel(panelExecutionId, [currentResult], 0);
          onUpdate?.({
            content: partial.content ?? [{ type: "text", text: "(running...)" }],
            details: makeDetails("single")([currentResult]),
          });
        };
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          singleUpdate,
          makeDetails("single"),
        );
        updateAgentPanel(panelExecutionId, [result], 0);
        const isError = isFailedResult(result);
        if (isError) {
          const errorMsg = getResultOutput(result);
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      try {
        return renderResultImpl(result, expanded, theme);
      } catch {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
    },
  });
}

// renderResultImpl 仅渲染简短状态，详细动态统一由实时面板承载。
function renderResultImpl(
  result: { content: any[]; details: any },
  _expanded: boolean,
  theme: any,
): any {
  const details = result.details as SubagentDetails | undefined;
  if (!details || details.results.length === 0) {
    const text = result.content?.[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  const results = details.results;
  const running = results.filter((entry) => entry.exitCode === -1).length;
  const failed = results.filter((entry) => entry.exitCode !== -1 && isFailedResult(entry)).length;
  const completed = results.length - running;
  const icon = running
    ? theme.fg("warning", "●")
    : failed
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");
  const title = `${icon} ${theme.fg("toolTitle", theme.bold(`subagent ${details.mode}`))}`;
  let text = `${title}${theme.fg("muted", ` ${completed}/${results.length} done${running ? `, ${running} running` : ""}`)}`;

  for (const entry of results) {
    const status =
      entry.exitCode === -1
        ? theme.fg("warning", "running")
        : isFailedResult(entry)
          ? theme.fg("error", entry.stopReason ? `failed (${entry.stopReason})` : "failed")
          : theme.fg("success", "completed");
    const runLabel = entry.runId ? theme.fg("dim", ` · ${entry.runId.slice(-6)}`) : "";
    text += `\n  ${theme.fg("accent", entry.agent)}${runLabel} ${status}`;

    // 失败原因保留极短摘要，避免把完整子 Agent 输出再渲染一次。
    if (isFailedResult(entry)) {
      const reason = entry.errorMessage || entry.stderr;
      if (reason) {
        const preview = reason.replace(/\s+/g, " ").slice(0, 180);
        text += `\n    ${theme.fg("error", preview + (reason.length > 180 ? "…" : ""))}`;
      }
    }
  }

  const totalUsage = results.reduce(
    (total, entry) => ({
      input: total.input + entry.usage.input,
      output: total.output + entry.usage.output,
      cacheRead: total.cacheRead + entry.usage.cacheRead,
      cacheWrite: total.cacheWrite + entry.usage.cacheWrite,
      cost: total.cost + entry.usage.cost,
      turns: total.turns + entry.usage.turns,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  );
  const usage = formatUsageStats(totalUsage);
  if (usage) text += `\n${theme.fg("dim", `  ${usage}`)}`;
  text += `\n${theme.fg("dim", "  实时动态见 Subagents 面板")}`;
  return new Text(text, 0, 0);
}
