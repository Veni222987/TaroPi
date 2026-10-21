import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanFile } from "./types.ts";

const EXECUTE_PLAN_LABEL = "开始实施";
const ADJUST_PLAN_LABEL = "补充内容";
const DEFER_PLAN_LABEL = "暂不决定";

export type PlanDecision = "execute" | "supplement" | "cancelled";

// showPlanDecision 使用原生选择框，补充输入交还主输入框，不接管编辑器。
export async function showPlanDecision(ctx: ExtensionContext, file?: PlanFile, signal?: AbortSignal): Promise<PlanDecision> {
	if (!ctx.hasUI) throw new Error("当前模式没有确认 UI，不能批准实施；请在 TUI 或 RPC 会话中提交计划");
	if (signal?.aborted) return "cancelled";
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select(
			`计划已生成，如何继续？\n计划文件: ${file?.path ?? "未保存"}\n选择“补充内容”后返回主输入框；“暂不决定”保留计划并等待。`,
			[EXECUTE_PLAN_LABEL, ADJUST_PLAN_LABEL, DEFER_PLAN_LABEL], { signal },
		);
	} catch (error) {
		if (signal?.aborted && error instanceof Error && error.name === "AbortError") return "cancelled";
		throw error;
	}
	if (signal?.aborted) return "cancelled";
	if (choice === EXECUTE_PLAN_LABEL) return "execute";
	if (choice === ADJUST_PLAN_LABEL) return "supplement";
	return "cancelled";
}
