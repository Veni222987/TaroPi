import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommandPromptRenderer, sendCommandPrompt } from "../command-prompt/index.ts";
import { renderAskMessage } from "./prompt.ts";

const ASK_MESSAGE = "taropi-ask";

// registerAsk 注册一次性 /ask：界面显示原始输入，模型收到查证要求与问题的合成提示词。
export function registerAsk(pi: ExtensionAPI): void {
	registerCommandPromptRenderer(pi, ASK_MESSAGE);
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
			sendCommandPrompt(pi, ASK_MESSAGE, renderAskMessage(question), { input: `/ask ${question}` }, { triggerTurn: true });
		},
	});
}
