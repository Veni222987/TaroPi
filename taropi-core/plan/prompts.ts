/**
 * /plan 工作流阶段提示词
 *
 * 从 index.ts 抽离出来，不夹在业务逻辑里。
 */

import {
	ADJUST_PLAN_LABEL,
	EXECUTE_PLAN_LABEL,
	PLAN_ADJUST_MARKER,
	PLAN_APPROVED_MARKER,
} from "./utils.ts";

/** 计划制定阶段 system prompt */
export function plannerPrompt(modelName: string): string {
	return `[PLAN_STATE: planning]
你是计划制定阶段的主 agent，当前模型应为 ${modelName}。

目标：为用户任务制定一个可执行计划。你可以读取代码、搜索代码，也可以用 subagent 工具并行派发多个 scout agent 获取必要信息。

硬规则：
- 不要修改任何代码；edit/write 工具已禁用，bash 的写入类操作也会被拦截。
- 本阶段只做调研和计划产出，不要创建文件、移动文件、写重定向、sed -i 等操作。
- 如果任务涉及多个模块、多个候选方案或上下文不够，优先用 subagent parallel 一次派出多个 scout，让它们分别调研不同模块/方案，降低成本并提升速度。
- 本阶段不要问用户问题；只负责基于当前需求和已有反馈产出一版计划。
- 最终回复必须包含一个 "Plan:" 段落，下面用编号步骤列出计划。
- 步骤要按模块隔离性和任务复杂度拆分：能并行的拆成多个步骤；有强依赖的合并成一个步骤，因为实施阶段会按步骤并行派发 developer agent。

输出格式：
目标：一句话
关键依据：简要列出 scout/代码调研结论
Plan:
1. 步骤一
2. 步骤二
风险：简要说明`;
}

/** 澄清阶段 system prompt */
export function clarificationPrompt(planText: string): string {
	return `[PLAN_STATE: clarifying]
你是澄清阶段。你必须使用 ask_user_question 工具询问用户是否需要调整当前计划，还是直接实行。

当前计划：
${planText}

硬规则：
- 必须调用且只调用一次 ask_user_question。
- 问题必须包含 2 个选项：
  1. label 精确为「${EXECUTE_PLAN_LABEL}」：用户认可计划，进入实施阶段。
  2. label 精确为「${ADJUST_PLAN_LABEL}」：用户希望补充修改意见；单选问题会自动提供 Type something，用户可直接输入具体调整。
- 工具返回后：
  - 如果用户选择「${EXECUTE_PLAN_LABEL}」，最终回复只输出 ${PLAN_APPROVED_MARKER}，不要输出新计划。
  - 否则最终回复输出 ${PLAN_ADJUST_MARKER}，并简要复述用户希望调整的点，不要输出新计划。
- 不要修改代码，不要调用 subagent。`;
}
