import type { PlanConfig, WorkflowState } from "./types.ts";

export const PLANNING_PROMPT = `进入计划制定阶段：调研、澄清并制定可执行计划。
- 禁止 edit、write。其他工具和 shell 脚本可按需用于调研、查询和获取信息，但只能进行读操作，禁止实际修改本地或远程数据；工作流自身保存计划 Markdown 是必要例外。现有权限规则仍生效。
- 详细计划前反复澄清不确定点，必要时使用 ask_user_question，直到需求和实现边界足够明确；不要提前输出计划。
- 模块、目录、代码和测试遵循当前项目风格。
- 完整计划格式：目标：、关键依据：、Plan:、计划标题：、编号改动步骤、风险：。
- 需求明确后调用 plan(action="submit", text=完整计划)，工具会询问真实用户。不能自行批准；选择补充内容后回主输入框，取消或暂不决定后保持计划中并等待用户输入，不自动澄清或重新提交。
- 用户要求退出时调用 plan(action="exit")；中断不等于退出。压缩或恢复后不确定阶段时调用 plan(action="status")。`;

export const IMPLEMENTING_PROMPT = `计划已获用户确认，进入实施阶段。按已确认计划执行任务。
- 实际依赖需要调整顺序时说明原因，完成后执行必要的测试、构建或校验。
- 中断、报错或手动切换模型都不表示完成；恢复后先核实已有副作用，不盲目重放工具。
- 完成时调用 plan(action="complete", text=结果、验证与遗留风险)，不能把 Agent 停止当作完成。
- 用户要求退出时调用 plan(action="exit")。压缩或恢复后不确定阶段时调用 plan(action="status")。`;

export const IDLE_PROMPT = "当前处于非 plan 流程，之前的 plan 阶段限制已解除，仍遵守当前权限规则。只有用户执行 /plan 可以进入计划流程，模型不能自行进入。";

// phaseMessage 返回一次性阶段规则及工作检查点，不修改系统提示或历史消息。
export function phaseMessage(state: WorkflowState, config: PlanConfig): string {
	return [
		`当前阶段：${state.phase}`,
		config[state.phase].prompt,
		state.task ? `原始任务：\n${state.task}` : "",
		state.planFile ? `计划文件：${state.planFile.path}` : "",
		state.phase === "idle" ? "" : `当前计划：\n${state.planText || "尚未提交"}`,
		state.pendingLaunch ? "用户已确认，实施提示尚待送达；不要提前执行写操作。" : "",
	].filter(Boolean).join("\n\n");
}
