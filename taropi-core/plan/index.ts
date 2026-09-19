import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHudPanel, requestHudRefresh } from "../hud/registry.ts";
import type { HudTheme } from "../hud/theme.ts";
import { resolveModelAlias } from "../model-alias/store.ts";
import { plannerPrompt } from "./prompts.ts";
import { showPlanDecision, updatePlanFile, type PlanFile } from "./tui.ts";

const PLANNER_MODEL_NAME = "Aurum";
const PERSIST_ENTRY_TYPE = "plan-workflow";
const CONTEXT_TYPE = "plan-workflow-context";
const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls"];
const DISABLED_PLAN_TOOLS = new Set(["edit", "write", "subagent"]);
const SUBAGENT_TOOL = "subagent";

type WorkflowPhase = "idle" | "planning" | "clarifying" | "implementing";

interface WorkflowState {
	phase: WorkflowPhase;
	task: string;
	planText: string;
	planFile?: PlanFile;
	adjustmentRounds: number;
}

interface PersistedState {
	phase?: WorkflowPhase;
	task?: string;
	planText?: string;
	planMdPath?: string;
	planCreatedAt?: string;
	adjustmentRounds?: number;
}

function emptyState(): WorkflowState {
	return { phase: "idle", task: "", planText: "", adjustmentRounds: 0 };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function messageText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function extractPlan(message: string): string | undefined {
	const match = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!match || match.index === undefined) return undefined;
	const plan = message.slice(match.index + match[0].length).trim();
	return /^\s*\d+[.)]\s+.+/m.test(plan) ? plan : undefined;
}

function planningMessage(task: string, feedback?: string): string {
	if (!feedback) return `进入计划制定阶段。用户任务：\n${task}`;
	return `请根据用户补充继续澄清并更新计划。\n\n原始任务：\n${task}\n\n用户补充：\n${feedback}`;
}

function implementationMessage(task: string, plan: string): string {
	return `计划已获用户确认，进入实施阶段。请在当前工作目录直接执行下列计划。\n\n执行要求：\n- 按计划修改代码；实际依赖需要调整顺序时说明原因。\n- 完成后运行必要的测试、构建或校验，并汇报变更、验证结果和遗留风险。\n\n原始任务：\n${task}\n\n已确认计划：\n${plan}`;
}

function findModel(ctx: ExtensionContext, name: string): Model<Api> | undefined {
	const alias = resolveModelAlias(name);
	if (alias) {
		const separator = alias.indexOf("/");
		if (separator > 0) {
			const model = ctx.modelRegistry.find(alias.slice(0, separator), alias.slice(separator + 1));
			if (model) return model;
		}
	}
	return ctx.modelRegistry.getAll().find((model) => model.name === name);
}

function createRuntime(pi: ExtensionAPI) {
	let originalModel: Model<Api> | undefined;
	let originalTools: string[] | undefined;

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
		originalModel ??= ctx.model;
		originalTools ??= pi.getActiveTools();

		const model = findModel(ctx, PLANNER_MODEL_NAME);
		if (model) {
			if (!(await pi.setModel(model))) ctx.ui.notify(`没有 ${PLANNER_MODEL_NAME} 的可用凭证，继续使用当前模型规划`, "warning");
		} else {
			ctx.ui.notify(`未找到模型 ${PLANNER_MODEL_NAME}，继续使用当前模型规划`, "warning");
		}

		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(
			[...new Set([...(originalTools ?? []).filter((tool) => !DISABLED_PLAN_TOOLS.has(tool)), ...PLANNING_TOOLS])].filter((tool) => available.has(tool)),
		);
	}

	async function enterImplementation(): Promise<void> {
		if (originalModel) await pi.setModel(originalModel);
		pi.setActiveTools((originalTools ?? pi.getActiveTools()).filter((tool) => tool !== SUBAGENT_TOOL));
	}

	async function restore(): Promise<void> {
		if (originalModel) await pi.setModel(originalModel);
		if (originalTools) pi.setActiveTools(originalTools);
		originalModel = undefined;
		originalTools = undefined;
	}

	return { enterPlanning, enterImplementation, restore };
}

function persist(pi: ExtensionAPI, state: WorkflowState): void {
	pi.appendEntry(PERSIST_ENTRY_TYPE, {
		phase: state.phase,
		task: state.task,
		planText: state.planText,
		planMdPath: state.planFile?.path,
		planCreatedAt: state.planFile?.createdAt.toISOString(),
		adjustmentRounds: state.adjustmentRounds,
	} satisfies PersistedState);
}

function restoreState(ctx: ExtensionContext): WorkflowState | undefined {
	const entry = ctx.sessionManager
		.getEntries()
		.filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === PERSIST_ENTRY_TYPE)
		.pop() as { data?: PersistedState } | undefined;
	if (!entry?.data) return undefined;

	const { data } = entry;
	return {
		phase: "idle",
		task: data.task ?? "",
		planText: data.planText ?? "",
		planFile: data.planMdPath && data.planCreatedAt ? { path: data.planMdPath, createdAt: new Date(data.planCreatedAt) } : undefined,
		adjustmentRounds: data.adjustmentRounds ?? 0,
	};
}

function registerPlanHud(getState: () => WorkflowState): void {
	registerHudPanel({
		key: PERSIST_ENTRY_TYPE,
		render(theme: HudTheme): string[] {
			const state = getState();
			if (state.phase === "idle") return [];
			const phase = state.phase === "planning" ? "计划制定" : state.phase === "clarifying" ? "澄清确认" : "直接实施";
			return [`${theme.c("🧭", theme.YELLOW)} ${theme.c("plan", theme.YELLOW)} ${theme.c(phase, theme.FG)} ${theme.dim(`调整 ${state.adjustmentRounds} 轮`)}`];
		},
	});
}

function isMutatingCommand(command: string): boolean {
	return [
		/>/, />>/, /(?:^|[;&|])\s*(?:tee|mkdir|touch|rm|mv|cp|dd|chmod|chown|ln)\s/,
		/\bsed\s+-i\b/, /(?:^|[;&|])\s*(?:npm\s+(?:i|install|init)|yarn\s+(?:add|init)|pnpm\s+(?:add|install)|pip\d*\s+install)\b/,
		/(?:^|[;&|])\s*git\s+(?:add|commit|stash\s+(?:push|pop|apply|drop|branch)|merge\s|rebase\s|cherry-pick|checkout|switch|branch\s+-[dD])\b/,
	].some((pattern) => pattern.test(command.trim()));
}

// registerPlan 注册 /plan 三阶段状态机。
export default function registerPlan(pi: ExtensionAPI): void {
	let state = emptyState();
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let completionGeneration = 0;
	const runtime = createRuntime(pi);

	function save(): void {
		requestHudRefresh();
		persist(pi, state);
	}

	function setPhase(phase: WorkflowPhase): void {
		state.phase = phase;
		save();
	}

	function cancelCompletion(): void {
		completionGeneration++;
		if (completionTimer) clearTimeout(completionTimer);
		completionTimer = undefined;
	}

	function reset(): void {
		cancelCompletion();
		state = emptyState();
		save();
	}

	async function finishImplementation(): Promise<void> {
		updatePlanFile(state.planFile, state.planText, "completed");
		await runtime.restore();
		pi.sendMessage({ customType: "plan-completed", content: "计划实施完成，已恢复原模型与工具集。", display: true }, { triggerTurn: false });
		reset();
	}

	function scheduleCompletion(ctx: ExtensionContext): void {
		cancelCompletion();
		const generation = completionGeneration;
		const check = (): void => {
			if (generation !== completionGeneration || state.phase !== "implementing") return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				completionTimer = setTimeout(check, 10);
				return;
			}
			void finishImplementation();
		};
		completionTimer = setTimeout(check, 0);
	}

	async function startImplementation(): Promise<void> {
		cancelCompletion();
		setPhase("implementing");
		updatePlanFile(state.planFile, state.planText, "implementing");
		await runtime.enterImplementation();
		pi.sendMessage({ customType: "plan-implementation-start", content: "计划已确认，进入主 Agent 实施阶段。", display: true }, { triggerTurn: false });
		pi.sendUserMessage(implementationMessage(state.task, state.planText), { deliverAs: "followUp" });
	}

	registerPlanHud(() => state);

	pi.registerCommand("plan", {
		description: "启动计划流程：制定计划 → 澄清确认 → 主 Agent 实施",
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
			await runtime.enterPlanning(ctx);
			state = { ...emptyState(), phase: "planning", task };
			save();
			pi.sendUserMessage(planningMessage(task), { deliverAs: "followUp" });
		},
	});

	pi.on("before_agent_start", async () => {
		if (state.phase !== "planning") return;
		return { message: { customType: CONTEXT_TYPE, content: plannerPrompt(), display: false } };
	});

	pi.on("context", async (event) => {
		if (state.phase !== "idle") return;
		return { messages: event.messages.filter((message) => (message as AgentMessage & { customType?: string }).customType !== CONTEXT_TYPE) };
	});

	pi.on("model_select", async (event, ctx) => {
		if (state.phase !== "planning" && state.phase !== "clarifying") return;
		if (event.source !== "cycle") return;
		const model = findModel(ctx, PLANNER_MODEL_NAME);
		if (!model || !(await pi.setModel(model))) {
			ctx.ui.notify(`计划阶段请勿切换模型。${PLANNER_MODEL_NAME} 不可用，无法自动恢复。`, "warning");
			return;
		}
		ctx.ui.notify(`计划制定阶段已锁定模型为 ${PLANNER_MODEL_NAME}，请完成计划后再切换。`, "warning");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === SUBAGENT_TOOL && state.phase !== "idle") {
			return { block: true, reason: "当前计划阶段不可用此工具。" };
		}
		if (state.phase !== "planning" || event.toolName !== "bash") return;
		const command = (event.input as { command?: string }).command ?? "";
		if (!isMutatingCommand(command)) return;
		ctx.ui.notify(`⛔ 计划阶段禁止写操作: ${command.slice(0, 40)}`, "warning");
		return { block: true, reason: "计划制定阶段只允许读取和分析代码，禁止写入文件或安装依赖。" };
	});

	pi.on("agent_start", async () => {
		if (state.phase === "implementing") cancelCompletion();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase === "implementing") {
			scheduleCompletion(ctx);
			return;
		}
		if (state.phase !== "planning") return;
		const message = [...event.messages].reverse().find(isAssistantMessage);
		const plan = message ? extractPlan(messageText(message)) : undefined;
		if (!plan) return;

		state.planText = plan;
		setPhase("clarifying");
		ctx.compact();
		const review = await showPlanDecision(ctx, plan, state.planFile);
		if (review.file) state.planFile = review.file;
		save();
		if (review.decision.execute) {
			await startImplementation();
			return;
		}

		state.adjustmentRounds++;
		setPhase("planning");
		pi.sendUserMessage(planningMessage(state.task, review.decision.feedback ?? "请继续澄清仍不确定的部分，再制定新版计划。"), { deliverAs: "followUp" });
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx) ?? emptyState();
		requestHudRefresh();
	});
}
