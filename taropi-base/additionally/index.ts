import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerAdditionally(pi: ExtensionAPI) {
  pi.registerCommand("additionally", {
    description: "在 react 过程中补充操作说明，agent 运行中时立即注入当前执行流",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("用法：/additionally <补充说明>", "error");
        return;
      }
      pi.sendUserMessage(text, { deliverAs: "steer" });
    },
  });
}
