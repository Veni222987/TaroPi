import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderAskMessage } from "./prompt.ts";

// registerAsk 注册一次性 /ask：只在空闲时把查证要求和问题合成一条用户消息。
export function registerAsk(pi: ExtensionAPI): void {
	pi.registerCommand("ask", {
		description: "用详细例子和可核对证据回答这一个问题：/ask 问题",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("用法：/ask 问题", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("当前正在回复，请等待结束后再使用 /ask", "warning");
				return;
			}
			pi.sendUserMessage(renderAskMessage(question), { expandPromptTemplates: false });
		},
	});
}
