import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlanWorkflow } from "./workflow.ts";

const PLAN_PARAMETERS = Type.Object({
	action: StringEnum(["status", "submit", "complete", "exit"] as const),
	text: Type.Optional(Type.String({ description: "submit 的完整计划，或 complete 的结果、验证和风险" })),
});

// registerPlanTool 注册固定声明的顺序流转工具，模型不能借工具进入计划模式。
export function registerPlanTool(pi: ExtensionAPI, workflow: PlanWorkflow): void {
	pi.registerTool({
		name: "plan",
		label: "Plan",
		description: "管理由用户 /plan 启动的三态工作流：status 查询状态和规则；submit 提交完整计划并由真实用户弹窗确认；complete 明确完成；exit 退出。不能自行进入计划模式。",
		promptSnippet: "查询或流转用户 /plan 启动的工作流",
		promptGuidelines: ["只有用户 /plan 可以进入计划模式。计划中提交完整计划用 plan submit；用户自然语言要求退出时调用 plan exit；实施完毕用 plan complete 附验证摘要。压缩或恢复后不确定阶段时调用 plan status。"],
		exposure: "model-only",
		executionMode: "sequential",
		parameters: PLAN_PARAMETERS,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await workflow.dispatch(params, ctx, signal);
			return { content: [{ type: "text", text: result.text }], details: undefined, terminate: result.terminate };
		},
	});
}
