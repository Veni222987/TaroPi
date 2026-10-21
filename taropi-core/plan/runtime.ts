import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelAlias } from "../model-alias/store.ts";

// switchPlanModel 仅在明确进入阶段时切换模型，失败时告警并保留当前模型。
export async function switchPlanModel(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined): Promise<void> {
	if (!name) return;
	try {
		const resolved = resolveModelAlias(name) ?? name;
		const separator = resolved.indexOf("/");
		const model = separator > 0 ? ctx.modelRegistry.find(resolved.slice(0, separator), resolved.slice(separator + 1)) : undefined;
		if (!model) {
			ctx.ui.notify(`未找到模型 ${name}，继续使用当前模型`, "warning");
			return;
		}
		if (model.provider === ctx.model?.provider && model.id === ctx.model?.id) return;
		if (!(await pi.setModel(model))) ctx.ui.notify(`模型 ${name} 无可用凭证，继续使用当前模型`, "warning");
	} catch (error) {
		ctx.ui.notify(`切换模型 ${name} 失败，继续使用当前模型：${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}
