import type { ExtensionAPI, ExtensionContext, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { loadPreamble, type PreambleLoadResult } from "./config.ts";
import { hasFullSystemPromptOverride, replacePreambleInMessages } from "./prompt.ts";

interface PreambleState {
  config: PreambleLoadResult;
  reported: Set<string>;
  runOptions?: NormalizedBuildSystemPromptOptions;
}

// register 注册全局 PREAMBLE.md 角色文本替换模块。
export function register(pi: ExtensionAPI): void {
  const state: PreambleState = {
    config: loadPreamble(),
    reported: new Set(),
  };

  const reload = (): void => {
    state.config = loadPreamble();
    state.reported.clear();
    state.runOptions = undefined;
  };

  pi.on("session_start", () => {
    reload();
  });

  pi.on("before_agent_start", (event, ctx) => {
    state.runOptions = event.systemPromptOptions;
    if (state.config.error) {
      reportOnce(state, ctx, "read-error", `无法读取 ${state.config.path}，已保留 Pi 默认角色文本。`);
    }
  });

  pi.on("context_with_system", (event, ctx) => {
    const preamble = state.config.preamble;
    if (!preamble) return;

    if (state.runOptions && hasFullSystemPromptOverride(state.runOptions)) {
      reportOnce(state, ctx, "full-override", "检测到 Pi 完整系统提示词覆盖，已跳过 PREAMBLE.md 角色替换。");
      return;
    }

    const messages = replacePreambleInMessages(event.messages, preamble);
    if (messages !== event.messages) return { messages };
  });
}

function reportOnce(state: PreambleState, ctx: ExtensionContext, key: string, message: string): void {
  if (state.reported.has(key)) return;
  state.reported.add(key);

  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }
  process.stderr.write(`[taropi-core] ${message}\n`);
}
