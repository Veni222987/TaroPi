/**
 * /plan 三阶段状态机装配层
 *
 * State A: planning      - 主 agent 切换到 Aurum，独立完成调研并产出 Plan。
 * State B: clarifying    - 计划生成后代码直接弹出选择框（开始实施/补充内容），用户选择后同步触发状态流转。
 * State C: implementing  - 恢复主 agent 的模型和读写工具，直接执行已确认计划。
 *
 * 运行时 key（勿改，保证旧会话兼容）：
 * - PERSIST_ENTRY_TYPE = "plan-workflow"
 * - HUD key = "plan-workflow"
 * - customType = "plan-workflow-context"
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHudPanel, requestHudRefresh } from "../hud/registry.ts";
import type { HudTheme } from "../hud/theme.ts";
import { resolveModelAlias } from "../model-alias/store.ts";
import {
	extractPlanSection,
	extractPlanSteps,
	type PlanStatus,
	updatePlanMarkdown,
	writePlanMarkdown,
} from "./utils.ts";
import { plannerPrompt } from "./prompts.ts";
import { askPlanDecision } from "./ask-user-question.ts";

// --- 常量 ----------------------------------------------------------------

const PLANNER_MODEL_NAME = "Aurum";
const PLANNING_EXTRA_TOOLS = ["read", "bash", "grep", "find", "ls"];
const PLANNING_DISABLED_TOOLS = new Set(["edit", "write", "subagent"]);
const IMPLEMENTING_DISABLED_TOOLS = new Set(["subagent"]);
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

// implementationMessageFor 将已确认计划交给主 agent 直接实施
function implementationMessageFor(task: string, planText: string): string {
	return `计划已获用户确认，现进入实施阶段。请使用当前主 agent 的完整读写工具，直接在当前工作目录执行下面的已确认计划。\n\n执行要求：\n- 按计划顺序修改代码；根据实际依赖调整顺序时要说明原因。\n- 完成后运行必要的测试、构建或校验，并在最终回复中汇报变更、验证结果和遗留风险。\n\n原始任务：\n${task}\n\n已确认计划：\n${planText}`;
}

// --- 阶段提示词 ----------------------------------------------------------

function workflowPrompt(state: WorkflowState): string | undefined {
	if (state.phase === "planning") return plannerPrompt(PLANNER_MODEL_NAME);
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
// --- 模型查找工具 --------------------------------------------------------

// findModelByName 按名称查找模型，优先通过 model-alias 档位名（Aurum/Au 等）解析
function findModelByName(ctx: ExtensionContext, name: string): Model<any> | undefined {
	const aliasTarget = resolveModelAlias(name);
	if (aliasTarget) {
		const slash = aliasTarget.indexOf("/");
		if (slash > 0) {
			const found = ctx.modelRegistry.find(aliasTarget.slice(0, slash), aliasTarget.slice(slash + 1));
			if (found) return found;
		}
	}
	// 未设置别名或解析失败时，回退按 Model.name 精确匹配
	return ctx.modelRegistry.getAll().find((m) => m.name === name);
}

// --- planner runtime 切换 ------------------------------------------------

// createRuntime 创建 planner runtime 切换实例，管理模型与工具集的保存/恢复
function createRuntime(pi: ExtensionAPI) {
	let savedModel: Model<any> | undefined;
	let savedTools: string[] | undefined;

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

	// enterImplementationRuntime 恢复主 agent 的模型和完整读写工具
	async function enterImplementationRuntime(): Promise<void> {
		if (savedModel) await pi.setModel(savedModel);
		const baseTools = savedTools ?? pi.getActiveTools();
		pi.setActiveTools(baseTools.filter((tool) => !IMPLEMENTING_DISABLED_TOOLS.has(tool)));
	}

	// restoreRuntime 恢复到进入 planner 前的模型和工具集
	async function restoreRuntime(): Promise<void> {
		if (savedModel) await pi.setModel(savedModel);
		if (savedTools) pi.setActiveTools(savedTools);
		savedModel = undefined;
		savedTools = undefined;
	}

	return { enterPlannerRuntime, enterImplementationRuntime, restoreRuntime };
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

// --- HUD -----------------------------------------------------------------

// registerPlanHud 注册 plan workflow 的 HUD panel，state 以 getter 形式传入避免闭包过早捕获
function registerPlanHud(getState: () => WorkflowState): void {
	registerHudPanel({
		key: "plan-workflow",
		render(theme: HudTheme): string[] {
			const state = getState();
			if (state.phase === "idle") return [];
			const label =
				state.phase === "planning" ? "计划制定" : state.phase === "clarifying" ? "澄清确认" : "直接实施";
			return [
				`${theme.c("🧭", theme.YELLOW)} ${theme.c("plan", theme.YELLOW)} ${theme.c(label, theme.FG)} ${theme.dim(`调整 ${state.adjustmentRounds} 轮`)}`,
			];
		},
	});
}

// --- 装配 ----------------------------------------------------------------

// registerPlan 注册 /plan 三阶段状态机
export default function registerPlan(pi: ExtensionAPI): void {
	let state: WorkflowState = { phase: "idle", task: "", planText: "", adjustmentRounds: 0 };
	let implementationCompletionTimer: ReturnType<typeof setTimeout> | undefined;
	let implementationCompletionGeneration = 0;
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

	function cancelImplementationCompletion(): void {
		implementationCompletionGeneration++;
		if (implementationCompletionTimer) clearTimeout(implementationCompletionTimer);
		implementationCompletionTimer = undefined;
	}

	function scheduleImplementationCompletion(ctx: ExtensionContext): void {
		cancelImplementationCompletion();
		const generation = implementationCompletionGeneration;
		const check = (): void => {
			if (generation !== implementationCompletionGeneration || state.phase !== "implementing") return;
			// 等待 agent_end 后续的自动重试与 queued follow-up 排空后收口。
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				implementationCompletionTimer = setTimeout(check, 10);
				return;
			}
			void finishImplementation();
		};
		implementationCompletionTimer = setTimeout(check, 0);
	}

	function resetState(): void {
		cancelImplementationCompletion();
		state = { phase: "idle", task: "", planText: "", adjustmentRounds: 0 };
		refresh();
		persistState(pi, state);
	}

	// startImplementation 切回主 agent，按确认计划直接实施
	async function startImplementation(): Promise<void> {
		cancelImplementationCompletion();
		setPhase("implementing");
		syncPlanMarkdown("implementing");
		await runtime.enterImplementationRuntime();

		pi.sendMessage(
			{
				customType: "plan-implementation-start",
				content: "计划已确认，进入主 Agent 实施阶段。",
				display: true,
			},
			{ triggerTurn: false },
		);
		pi.sendUserMessage(implementationMessageFor(state.task, state.planText), { deliverAs: "followUp" });
	}

	// finishImplementation 标记计划完成并恢复用户原有模型、工具集
	async function finishImplementation(): Promise<void> {
		syncPlanMarkdown("completed");
		await runtime.restoreRuntime();
		pi.sendMessage(
			{
				customType: "plan-completed",
				content: "计划实施完成，已恢复原模型与工具集。",
				display: true,
			},
			{ triggerTurn: false },
		);
		resetState();
	}

	registerPlanHud(() => state);

	pi.registerCommand("plan", {
		description: "启动三阶段计划流程：制定计划 → 澄清确认 → 主 Agent 实施",
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
				return msg.customType !== "plan-workflow-context";
			}),
		};
	});

	// planning / clarifying 阶段拦截 Ctrl+P 模型切换
	// model_select source "cycle" 表示用户通过快捷键（Ctrl+P）手动切换模型
	pi.on("model_select", async (event, ctx) => {
		if (state.phase !== "planning" && state.phase !== "clarifying") return;
		if (event.source !== "cycle") return; // 只拦截手动快捷键，放行程序化 set/restore

		const plannerModel = findModelByName(ctx, PLANNER_MODEL_NAME);
		if (!plannerModel) {
			ctx.ui.notify("计划阶段请勿切换模型。未找到 Aurum 模型，无法自动恢复。", "warning");
			return;
		}

		// 如果当前已经是 planner 模型（理论上不应被切走，但防抖）则静默忽略
		if (ctx.model && ctx.model.provider === plannerModel.provider && ctx.model.id === plannerModel.id) {
			return;
		}

		// 切回 planner 模型
		const ok = await pi.setModel(plannerModel);
		if (ok) {
			ctx.ui.notify(
				`计划制定阶段已锁定模型为 ${PLANNER_MODEL_NAME}，请完成计划后再切换。`,
				"warning",
			);
		} else {
			ctx.ui.notify(
				`计划阶段请勿切换模型。${PLANNER_MODEL_NAME} 凭证不可用，无法自动恢复。`,
				"error",
			);
		}
	});

	// planning 阶段控制 bash 写入限制
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase === "planning" || state.phase === "implementing") {
			if (event.toolName === "subagent") {
				return { block: true, reason: "当前计划由主 Agent 执行。" };
			}
		}
		if (state.phase !== "planning") return;
		if (event.toolName !== "bash") return;
		const command: string = (event.input as { command?: string })?.command ?? "";
		const reason = isPlanningBashBlocked(command);
		if (reason) {
			ctx.ui.notify(`⛔ 计划阶段禁止写操作: ${command.slice(0, 40)}`, "warning");
			return { block: true, reason };
		}
	});

	pi.on("agent_start", async () => {
		if (state.phase === "implementing") cancelImplementationCompletion();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase === "implementing") {
			scheduleImplementationCompletion(ctx);
			return;
		}
		if (state.phase !== "planning") return;
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
		}
		const planMdPath = state.planMdPath;
		if (!planMdPath) return;
		setPhase("clarifying");
		syncPlanMarkdown("clarifying");

		// 选择框直接显示计划文件位置，避免计划提示被 overlay 遮住后延迟出现。
		const decision = await askPlanDecision(ctx, planMdPath);
		if (decision.execute) {
			await startImplementation();
			return;
		}

		state.adjustmentRounds++;
		setPhase("planning");
		syncPlanMarkdown("planning");
		pi.sendUserMessage(
			planMessageFor(
				state.task,
				decision.feedback || "用户希望调整计划，但没有提供更具体的说明。请先根据当前上下文补足最可能需要确认的点，再出新版计划。",
			),
			{ deliverAs: "followUp" },
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoreState(ctx);
		if (restored) state = restored;
		refresh();
	});
}
