import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHudClient } from "taropi-hud/api";
import { registerPlanTool } from "./tool.ts";
import { PlanWorkflow } from "./workflow.ts";

// registerPlan 注册唯一入口 /plan、固定流转工具及会话恢复，不改写历史或工具声明。
export default function registerPlan(pi: ExtensionAPI): void {
	const hud = createHudClient(pi);
	const workflow = new PlanWorkflow(pi, () => hud.render());
	hud.register({
		key: "plan-workflow",
		refresh: () => undefined,
		render(_panel, theme) {
			const state = workflow.state;
			if (state.phase === "idle") return [];
			const label = state.phase === "planning" ? "计划中" : "实施中";
			return [`${theme.c("🧭 plan", theme.YELLOW)} ${theme.c(label, theme.FG)} ${theme.dim(`调整 ${state.adjustmentRounds} 轮${state.pendingLaunch ? " · 待启动" : ""}`)}`];
		},
	});
	registerPlanTool(pi, workflow);
	pi.registerCommand("plan", {
		description: "进入会话级计划流程：只读调研 → 用户确认 → 实施",
		handler: (args, ctx) => workflow.enter(args, ctx),
	});
	pi.on("tool_call", (event) => {
		const reason = workflow.blockReason(event.toolName);
		if (reason) return { block: true, reason };
	});
	pi.on("input", (event, ctx) => workflow.input(event, ctx));
	pi.on("agent_settled", (event, ctx) => workflow.settled(ctx, event.aborted));
	pi.on("session_compact_failed", (event) => workflow.compactFailed(event.aborted));
	pi.on("session_start", (_event, ctx) => workflow.restore(ctx));
	pi.on("session_shutdown", () => workflow.invalidate());
}
