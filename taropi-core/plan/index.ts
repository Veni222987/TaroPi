import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHudClient } from "taropi-hud/api";
import { plannerPrompt } from "./prompts.ts";
import { updatePlanFile } from "./file.ts";
import { showPlanDecision } from "./tui.ts";
import { clearPlanState, loadPlanState, planStatePath, savePlanState } from "./store.ts";
import { emptyState } from "./types.ts";

const DISABLED_PLAN_TOOLS = new Set(["edit", "write"]);

// planningFailureReason 返回计划请求终止时可展示的失败原因。
export function planningFailureReason(message: AssistantMessage | undefined): string | undefined {
	if (!message || (message.stopReason !== "error" && message.stopReason !== "aborted")) return undefined;
	return message.errorMessage?.trim() || (message.stopReason === "aborted" ? "请求已取消" : "模型请求失败");
}

// registerPlan 注册不改写历史、模型和工具声明的三阶段计划工作流。
export default function registerPlan(pi: ExtensionAPI): void {
	const hud = createHudClient(pi);
	let state = emptyState();
	let statePath: string | undefined;
	let requestFailure: string | undefined;
	let storageWarningShown = false;
	let generation = 0;

	function save(ctx: ExtensionContext): void {
		hud.render();
		statePath ??= planStatePath(ctx.cwd, ctx.sessionManager.getSessionId());
		if (!savePlanState(statePath, state) && !storageWarningShown) {
			storageWarningShown = true;
			ctx.ui.notify("计划状态文件无法写入或清理，本轮仅保留内存状态。", "warning");
		}
	}

	function reset(ctx: ExtensionContext): void {
		generation++;
		requestFailure = undefined;
		state = emptyState();
		save(ctx);
	}

	hud.register({
		key: "plan-workflow",
		refresh: () => undefined,
		render(_panel, theme): string[] {
			if (state.phase === "idle") return [];
			const phase = state.phase === "planning" ? "计划制定" : state.phase === "clarifying" ? "澄清确认" : "直接实施";
			return [`${theme.c("🧭", theme.YELLOW)} ${theme.c("plan", theme.YELLOW)} ${theme.c(phase, theme.FG)} ${theme.dim(`调整 ${state.adjustmentRounds} 轮`)}`];
		},
	});

	pi.registerCommand("plan", {
		description: "启动计划流程：制定计划 → 澄清确认 → 主 Agent 实施（保持当前模型）",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("用法: /plan 任务描述", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/plan 需要交互界面确认计划，请在交互模式中执行。", "warning");
				return;
			}
			if (state.phase !== "idle") {
				ctx.ui.notify(`当前 /plan 仍在 ${state.phase} 阶段，请先完成或等待结束。`, "warning");
				return;
			}
			await ctx.waitForIdle();
			state = { ...emptyState(), phase: "planning", task };
			requestFailure = undefined;
			generation++;
			save(ctx);
			pi.sendUserMessage(planningMessage(task), { deliverAs: "followUp" });
		},
	});

	pi.on("tool_call", async (event) => {
		if ((state.phase === "planning" || state.phase === "clarifying") && DISABLED_PLAN_TOOLS.has(event.toolName)) {
			return { block: true, reason: "计划阶段禁止 edit/write。请完成调研并等待用户确认后再修改文件；也不要通过 bash 等工具绕过限制。" };
		}
	});

	pi.on("agent_start", async () => {
		requestFailure = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase !== "planning" && state.phase !== "implementing") return;
		const message = [...event.messages].reverse().find(isAssistantMessage);
		requestFailure = planningFailureReason(message);
		if (requestFailure || state.phase === "implementing") return;
		const plan = message ? extractPlan(messageText(message)) : undefined;
		if (!plan) return;

		state.planText = plan;
		state.phase = "clarifying";
		save(ctx);
		const currentGeneration = generation;
		const review = await showPlanDecision(ctx, plan, state.planFile);
		if (currentGeneration !== generation) return;
		if (review.file) state.planFile = review.file;
		if (review.decision.cancelled) {
			reset(ctx);
			ctx.ui.notify("计划已取消，未开始实施。", "info");
			return;
		}
		if (review.decision.execute) {
			state.phase = "implementing";
			updatePlanFile(state.planFile, state.planText, "implementing");
			save(ctx);
			pi.sendUserMessage(implementationMessage(state.task, state.planText), { deliverAs: "followUp" });
			return;
		}

		state.adjustmentRounds++;
		state.phase = "planning";
		save(ctx);
		pi.sendUserMessage(planningMessage(state.task, review.decision.feedback ?? "请继续澄清仍不确定的部分，再制定新版计划。"), { deliverAs: "followUp" });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (state.phase === "planning" && requestFailure) {
			const reason = requestFailure;
			reset(ctx);
			ctx.ui.notify(`计划制定失败，已退出计划模式，可重新执行 /plan。\n${reason}`, "error");
			return;
		}
		if (state.phase !== "implementing") return;
		const reason = requestFailure;
		if (!reason) updatePlanFile(state.planFile, state.planText, "completed");
		reset(ctx);
		ctx.ui.notify(reason ? `计划实施中断，未标记完成。\n${reason}` : "计划实施轮次已结束，计划文件已标记完成。", reason ? "error" : "info");
	});

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		if (statePath) clearPlanState(statePath);
		statePath = planStatePath(ctx.cwd, ctx.sessionManager.getSessionId());
		const previous = loadPlanState(statePath);
		state = emptyState();
		requestFailure = undefined;
		storageWarningShown = false;
		save(ctx);
		if (previous.phase !== "idle") ctx.ui.notify("已清理中断的计划工作流，可重新执行 /plan；历史计划文件保留。", "info");
	});

	pi.on("session_shutdown", async () => {
		generation++;
		if (statePath) clearPlanState(statePath);
		statePath = undefined;
		state = emptyState();
		requestFailure = undefined;
	});
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function messageText(message: AssistantMessage): string {
	return message.content.filter((content): content is TextContent => content.type === "text").map((content) => content.text).join("\n");
}

function extractPlan(message: string): string | undefined {
	const match = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!match || match.index === undefined) return undefined;
	const plan = message.slice(match.index + match[0].length).trim();
	return /^\s*\d+[.)]\s+.+/m.test(plan) ? plan : undefined;
}

function planningMessage(task: string, feedback?: string): string {
	if (!feedback) return `${plannerPrompt()}\n\n用户任务：\n${task}`;
	return `请根据用户补充继续澄清并更新计划，仍遵守计划阶段规则，不修改文件。\n\n原始任务：\n${task}\n\n用户补充：\n${feedback}`;
}

function implementationMessage(task: string, plan: string): string {
	return `计划已获用户确认，进入实施阶段，计划阶段的只读限制已解除。请在当前工作目录直接执行下列计划。\n\n执行要求：\n- 按计划修改代码；实际依赖需要调整顺序时说明原因。\n- 完成后运行必要的测试、构建或校验，并汇报变更、验证结果和遗留风险。\n\n原始任务：\n${task}\n\n已确认计划：\n${plan}`;
}
