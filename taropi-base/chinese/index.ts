import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 用英文写指令：模型对英文 system prompt 遵从度更高，
// 同时明确点出 <antml_thinking> block，避免模型只改最终回答而不改思考过程。
const PROMPT =
  "You MUST write your thinking / reasoning blocks entirely in Simplified Chinese (简体中文). " +
  "This applies to every <antml_thinking> block without exception. " +
  "Your final response should also be in Simplified Chinese unless the user explicitly requests otherwise.";

// registerChinese 强制模型用简体中文输出思考过程与回答
export function registerChinese(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + PROMPT,
    };
  });
}
