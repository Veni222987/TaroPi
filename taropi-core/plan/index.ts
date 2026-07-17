/**
 * /plan 三阶段状态机装配层
 *
 * State A: planning      - 主 agent 切换到 Aurum，可并行派发多个 scout agent 调研，产出 Plan。
 * State B: clarifying    - 主 agent 必须调用 ask_user_question，用户确认是否调整或直接实行。
 * State C: implementing  - 按步骤并行派发 developer agent，todo 跟踪进度。
 *
 * 运行时 key（勿改，保证旧会话兼容）：
 * - PERSIST_ENTRY_TYPE = "plan-workflow"
 * - HUD key = "plan-workflow"
 * - customType = "plan-workflow-context"（当前）／ "plan-with-todo-context"（旧版，仅过滤用）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getFinalOutput, mapWithConcurrencyLimit, MAX_CONCURRENCY, runSingleAgent } from "../sub-agents/engine.ts";
import type { SingleResult, SubagentDetails } from "../sub-agents/types.ts";
import { discoverAgents } from "../sub-agents/agents.ts";
import { registerHudPanel, requestHudRefresh } from "../hud/registry.ts";
import type { HudTheme } from "../hud/theme.ts";
import { getTodoController, type TodoController } from "../todo/index.ts";
import {
	ADJUST_PLAN_LABEL,
	collectAdjustmentFeedback,
	EXECUTE_PLAN_LABEL,
	extractPlanSection,
	extractPlanSteps,
	getCurrentTurnMessages,
	hasAskedUserQuestion,
	isExecuteSelected,
	type MinimalMessage,
	PLAN_ADJUST_MARKER,
	PLAN_APPROVED_MARKER,
	type PlanStatus,
	updatePlanMarkdown,
	writePlanMarkdown,
} from "./utils.ts";
import { plannerPrompt, clarificationPrompt } from "./prompts.ts";

// --- 常量 ----------------------------------------------------------------

const PLANNER_MODEL_NAME = "Aurum";
const PLANNING_EXTRA_TOOLS = ["read", "bash", "grep", "find", "ls", "subagent", "ask_user_question"];
const PLANNING_DISABLED_TOOLS = new Set(["edit", "write"]);
/** 持久化 entry type，勿改，保证旧会话兼容 */
const PERSIST_ENTRY_TYPE = "plan-workflow";

// --- 类型 ----------------------------------------------------------------

type WorkflowPhase = "idle" | "planning" | "clarifying" | "implementing";

interface WorkflowPersistedState {
	phase?: WorkflowPhase;
	task?: string;
	planText?: string;
	planMdPath?: string;
	planCreatedAt?: string;
	adjustmentRounds?: number;
}

interface WorkflowState {
	phase: WorkflowPhase;
	task: string;
	planText: string;
	planMdPath?: string;
	planCreatedAt?: Date;
	adjustmentRounds: number;
}

// --- 消息工具 ------------------------------------------------------------

// isAssistantMessage 判断消息是否为 AssistantMessage
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// getTextContent 提取 AssistantMessage 中的文本内容
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// planMessageFor 构造计划阶段的用户消息
function planMessageFor(task: string, feedback?: string): string {
	if (!feedback) return `进入计划制定阶段。用户任务：\n${task}`;
	return `用户对上一版计划提出了补充/调整意见，请回到计划制定阶段，结合原任务重新出一版计划。\n\n原任务：\n${task}\n\n用户反馈：\n${feedback}`;
}

// --- 阶段提示词 ----------------------------------------------------------

function workflowPrompt(state: WorkflowState): string | undefined {
	if (state.phase === "planning") return plannerPrompt(PLANNER_MODEL_NAME);
	if (state.phase === "clarifying") return clarificationPrompt(state.planText);
	return undefined;
}

// --- bash 写入类命令检测 -----------------------------------------------

/** 常见的写入/修改操作模式 */
const MUTATING_PATTERNS = [
	/>/,                                 // 输出重定向（包括 cat/echo > file）
	/>>/,                                // 追加重定向
	/(?:^|[;&|])\s*tee\s/,              // tee 写文件
	/(?:^|[;&|])\s*mkdir\s/,            // 创建目录
	/(?:^|[;&|])\s*touch\s/,            // 创建文件
	/(?:^|[;&|])\s*rm\s/,               // 删除
	/(?:^|[;&|])\s*mv\s/,               // 移动
	/(?:^|[;&|])\s*cp\s/,               // 复制
	/(?:^|[;&|])\s*dd\s/,               // 原始写入
	/(?:^|[;&|])\s*chmod\s/,            // 权限
	/(?:^|[;&|])\s*chown\s/,            // 所有者
	/(?:^|[;&|])\s*ln\s/,               // 链接
	/\bsed\s+-i\b/,                      // sed -i 原地编辑
	/(?:^|[;&|])\s*npm\s+(?:i|install|init)\b/,   // npm install
	/(?:^|[;&|])\s*yarn\s+(?:add|init)\b/,        // yarn add
	/(?:^|[;&|])\s*pnpm\s+(?:add|install)\b/,     // pnpm add
	/(?:^|[;&|])\s*pip\d*\s+install\b/,          // pip install
	/(?:^|[;&|])\s*git\s+(?:add|commit|stash\s+(?:push|pop|apply|drop|branch)|merge\s|rebase\s|cherry-pick|checkout|switch|branch\s+-[dD])\b/,
];

function isPlanningBashBlocked(command: string): string | null {
	const trimmed = command.trim();
	for (const re of MUTATING_PATTERNS) {
		if (re.test(trimmed)) {
			return "计划制定阶段禁止编辑/创建文件。只允许 ls/find/grep/cat/head/tail/git status 等只读操作。\n如果你需要读取分析代码，请使用 read/grep/find/ls 工具。";
		}
	}
	return null;
}
// --- planner runtime 切换 ------------------------------------------------

// createRuntime 创建 planner runtime 切换实例，管理模型与工具集的保存/恢复
function createRuntime(pi: ExtensionAPI) {
	let savedModel: Model<any> | undefined;
	let savedTools: string[] | undefined;

	function findModelByName(ctx: ExtensionContext, name: string): Model<any> | undefined {
		return ctx.modelRegistry.getAll().find((m) => m.name === name);
	}

	// enterPlannerRuntime 切换到 planner 模型和工具集
	async function enterPlannerRuntime(ctx: ExtensionContext): Promise<void> {
		if (!savedTools) savedTools = pi.getActiveTools();
		if (!savedModel) savedModel = ctx.model;

		const plannerModel = findModelByName(ctx, PLANNER_MODEL_NAME);
		if (plannerModel) {
			const ok = await pi.setModel(plannerModel);
			if (!ok) ctx.ui.notify(`没有 ${PLANNER_MODEL_NAME} 的可用凭证，继续使用当前模型规划`, "warning");
		} else {
			ctx.ui.notify(`未找到模型 ${PLANNER_MODEL_NAME}，继续使用当前模型规划`, "warning");
		}

		const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
		const nextTools = [
			...new Set([...(savedTools ?? []).filter((t) => !PLANNING_DISABLED_TOOLS.has(t)), ...PLANNING_EXTRA_TOOLS]),
		].filter((t) => allToolNames.has(t));
		pi.setActiveTools(nextTools);
	}

	// restoreRuntime 恢复到进入 planner 前的模型和工具集
	async function restoreRuntime(): Promise<void> {
		if (savedModel) await pi.setModel(savedModel);
		if (savedTools) pi.setActiveTools(savedTools);
		savedModel = undefined;
		savedTools = undefined;
	}

	return { enterPlannerRuntime, restoreRuntime };
}

// --- 持久化 --------------------------------------------------------------

// persistState 将当前 WorkflowState 写入会话 entry
function persistState(pi: ExtensionAPI, state: WorkflowState): void {
	pi.appendEntry(PERSIST_ENTRY_TYPE, {
		phase: state.phase,
		task: state.task,
		planText: state.planText,
		planMdPath: state.planMdPath,
		planCreatedAt: state.planCreatedAt?.toISOString(),
		adjustmentRounds: state.adjustmentRounds,
	} satisfies WorkflowPersistedState);
}

// restoreState 从会话 entry 恢复 WorkflowState（idle 阶段），无历史时返回 undefined
function restoreState(ctx: ExtensionContext): WorkflowState | undefined {
	const entry = ctx.sessionManager
		.getEntries()
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === PERSIST_ENTRY_TYPE)
		.pop() as { data?: WorkflowPersistedState } | undefined;

	if (!entry?.data) return undefined;
	return {
		phase: "idle",
		task: entry.data.task ?? "",
		planText: entry.data.planText ?? "",
		planMdPath: entry.data.planMdPath,
		planCreatedAt: entry.data.planCreatedAt ? new Date(entry.data.planCreatedAt) : undefined,
		adjustmentRounds: entry.data.adjustmentRounds ?? 0,
	};
}

// --- developer 派发与实施 -------------------------------------------------

// dispatchDeveloperAgents 并行派发 developer agent 执行各步骤，返回汇总报告
async function dispatchDeveloperAgents(
	cwd: string,
	steps: string[],
	planText: string,
	todo: TodoController,
): Promise<string> {
	const discovery = discoverAgents(cwd, "both");
	const developer = discovery.agents.find((a) => a.name === "developer");
	if (!developer) return "**Plan execution failed:** 未找到 name: developer 的 agent。";

	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "parallel",
		agentScope: "both",
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	});

	const results = await mapWithConcurrencyLimit(steps, MAX_CONCURRENCY, async (stepText, index) => {
		const step = index + 1;
		const result = await runSingleAgent(
			cwd,
			discovery.agents,
			developer.name,
			`你负责并行实施计划中的第 ${step} 步。\n\n完整计划：\n${planText}\n\n本步骤：\n${step}. ${stepText}\n\n只做本步骤，避免和其它 developer 的步骤抢改同一块逻辑；如果发现强依赖或冲突，请在输出中说明。`,
			cwd,
			step,
			undefined,
			undefined,
			makeDetails,
		);
		if (result.exitCode === 0) todo.complete(step);
		return result;
	});

	const succeeded = results.filter((r) => r.exitCode === 0).length;
	const summary = results
		.map((r) => {
			const output = getFinalOutput(r.messages) || r.stderr || "(no output)";
			const icon = r.exitCode === 0 ? "✓" : "✗";
			return `### Step ${r.step}: ${icon} ${r.agent}\n\n${output}`;
		})
		.join("\n\n---\n\n");
	return `**Plan Complete!** (${succeeded}/${results.length} developer agents succeeded)\n\n${summary}`;
}

// --- HUD -----------------------------------------------------------------

// registerPlanHud 注册 plan workflow 的 HUD panel，state 以 getter 形式传入避免闭包过早捕获
function registerPlanHud(getState: () => WorkflowState): void {
	registerHudPanel({
		key: "plan-workflow",
		render(theme: HudTheme): string[] {
			const state = getState();
			if (state.phase === "idle") return [];
			const label =
				state.phase === "planning" ? "计划制定" : state.phase === "clarifying" ? "澄清确认" : "并行实施";
			return [
				`${theme.c("🧭", theme.YELLOW)} ${theme.c("plan", theme.YELLOW)} ${theme.c(label, theme.FG)} ${theme.dim(`调整 ${state.adjustmentRounds} 轮`)}`,
			];
		},
	});
}

// --- 装配 ----------------------------------------------------------------

// registerPlan 注册 /plan 三阶段状态机
export default function registerPlan(pi: ExtensionAPI): void {
  const todo = getTodoController();
	let state: WorkflowState = { phase: "idle", task: "", planText: "", adjustmentRounds: 0 };
	const runtime = createRuntime(pi);

	function refresh(): void {
		requestHudRefresh();
	}

	function planStatusForPhase(phase: WorkflowPhase): PlanStatus {
		if (phase === "planning") return "planning";
		if (phase === "clarifying") return "clarifying";
		if (phase === "implementing") return "implementing";
		return "completed";
	}

	function syncPlanMarkdown(status = planStatusForPhase(state.phase)): void {
		if (!state.planMdPath || !state.planCreatedAt || !state.planText) return;
		updatePlanMarkdown(state.planMdPath, state.planText, state.planCreatedAt, status);
	}

	function setPhase(phase: WorkflowPhase): void {
		state.phase = phase;
		refresh();
		persistState(pi, state);
	}

	function resetState(): void {
		state = { phase: "idle", task: "", planText: "", adjustmentRounds: 0 };
		todo.clear();
		refresh();
		persistState(pi, state);
	}

	function startClarification(): void {
		setPhase("clarifying");
		syncPlanMarkdown("clarifying");
		pi.sendUserMessage("进入澄清阶段：请询问用户是否需要调整计划，或直接实行。", { deliverAs: "followUp" });
	}

	// startImplementation 进入实施阶段：解析步骤、替换 todo、派发 developer agent
	async function startImplementation(ctx: ExtensionContext, steps: string[]): Promise<void> {
		setPhase("implementing");
		syncPlanMarkdown("implementing");
		todo.replace(steps, state.planMdPath);
		await runtime.restoreRuntime();

		pi.sendMessage(
			{
				customType: "plan-implementation-start",
				content: `进入实施阶段：已根据模块隔离性拆出 ${steps.length} 个 todo，并行派发给 developer agent。\n\n${todo.renderPlain()}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		dispatchDeveloperAgents(ctx.cwd, steps, state.planText, todo)
			.then((summary) => {
				syncPlanMarkdown("completed");
				pi.sendMessage({ customType: "plan-complete", content: summary, display: true }, { triggerTurn: false });
			})
			.catch((err: Error) => {
				pi.sendMessage(
					{ customType: "plan-error", content: `**Plan execution failed:** ${err.message}`, display: true },
					{ triggerTurn: false },
				);
			})
			.finally(() => {
				resetState();
			});
	}

	registerPlanHud(() => state);

	pi.registerCommand("plan", {
		description: "启动状态机式计划流程：制定计划 → 澄清确认 → 并行实施",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("用法: /plan 任务描述", "info");
				return;
			}
			if (state.phase !== "idle") {
				ctx.ui.notify(`当前 /plan 仍在 ${state.phase} 阶段，请先完成或等待结束。`, "warning");
				return;
			}

			await runtime.enterPlannerRuntime(ctx);
			state = { phase: "planning", task, planText: "", adjustmentRounds: 0 };
			refresh();
			persistState(pi, state);
			pi.sendUserMessage(planMessageFor(task), { deliverAs: "followUp" });
		},
	});

	pi.on("before_agent_start", async () => {
		const prompt = workflowPrompt(state);
		if (!prompt) return;
		return { message: { customType: "plan-workflow-context", content: prompt, display: false } };
	});

	pi.on("context", async (event) => {
		// 退出 workflow 后过滤掉历史规划人格注入，避免污染普通对话
		if (state.phase !== "idle") return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType !== "plan-workflow-context" && msg.customType !== "plan-with-todo-context";
			}),
		};
	});

	// planning 阶段拦截 bash 的写入类命令（只读命令放行）
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase !== "planning") return;
		if (event.toolName !== "bash") return;
		const command: string = (event.input as { command?: string })?.command ?? "";
		const reason = isPlanningBashBlocked(command);
		if (reason) {
			ctx.ui.notify(`⛔ 计划阶段禁止写操作: ${command.slice(0, 40)}`, "warning");
			return { block: true, reason };
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase === "planning") {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (!lastAssistant) return;
			const text = getTextContent(lastAssistant);
			const planText = extractPlanSection(text);
			const steps = extractPlanSteps(text);
			if (!planText || steps.length === 0) return;

			state.planText = planText;
			if (!state.planMdPath || !state.planCreatedAt) {
				const written = writePlanMarkdown(ctx.cwd, planText, "clarifying");
				state.planMdPath = written.filePath;
				state.planCreatedAt = written.createdAt;
			} else {
				syncPlanMarkdown("clarifying");
			}
			persistState(pi, state);
			pi.sendMessage(
				{ customType: "plan-draft", content: `计划已生成：${state.planMdPath}`, display: true },
				{ triggerTurn: false },
			);
			startClarification();
			return;
		}

		if (state.phase === "clarifying") {
			const turnMessages = getCurrentTurnMessages(event.messages as unknown as MinimalMessage[]);
			if (!hasAskedUserQuestion(turnMessages)) {
				pi.sendUserMessage(
					"澄清阶段必须调用 ask_user_question 询问用户是否调整或实行，请现在调用。",
					{ deliverAs: "followUp" },
				);
				return;
			}
			if (isExecuteSelected(turnMessages)) {
				const steps = extractPlanSteps(`Plan:\n${state.planText}`);
				if (steps.length === 0) {
					ctx.ui.notify("当前计划没有解析出可执行步骤，回到计划制定阶段。", "warning");
					setPhase("planning");
					pi.sendUserMessage(
						"上一版计划没有可解析的编号步骤，请重新输出包含 Plan: 的编号计划。",
						{ deliverAs: "followUp" },
					);
					return;
				}
				await startImplementation(ctx, steps);
				return;
			}

			const feedback =
				collectAdjustmentFeedback(turnMessages) ||
				"用户希望调整计划，但没有提供更具体的说明。请先根据当前上下文补足最可能需要确认的点，再出新版计划。";
			state.adjustmentRounds++;
			setPhase("planning");
			syncPlanMarkdown("planning");
			pi.sendUserMessage(planMessageFor(state.task, feedback), { deliverAs: "followUp" });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoreState(ctx);
		if (restored) state = restored;
		refresh();
	});
}
