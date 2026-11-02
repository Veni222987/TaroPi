import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHudClient } from "taropi-hud/api";
import { compactUsingCuprum } from "./compactor.ts";
import { AutoCompactRuntime } from "./scheduler.ts";
import { AUTO_COMPACT_ENTRY, formatRulesStatus, type AutoCompactRule } from "./types.ts";
import { AutoCompactPanel } from "./ui.ts";

// registerAutoCompact 注册 /auto-compact、会话级调度和铜牌模型压缩。
export function registerAutoCompact(pi: ExtensionAPI): void {
  const runtime = new AutoCompactRuntime((rules) => {
    pi.appendEntry(AUTO_COMPACT_ENTRY, { rules });
  });
  const hud = createHudClient(pi);
  hud.register({
    key: "auto-compact",
    refresh: () => undefined,
    render(_state, theme) {
      const enabled = runtime.snapshot().filter((rule) => rule.enabled);
      if (enabled.length === 0) return [];
      return [`${theme.c("🗜 auto-compact", theme.CYAN)} ${theme.dim(formatRulesStatus(enabled))}`];
    },
  });

  pi.registerCommand("auto-compact", {
    description: "配置当前会话的自动压缩策略（every / idle / cron）",
    handler: async (args, ctx) => {
      runtime.ensureRestored(ctx);
      const command = args.trim();
      if (command === "clear") {
        runtime.save([], ctx);
        hud.render();
        ctx.ui.notify("已清空当前会话自动压缩策略", "info");
        return;
      }
      if (command === "status" || ctx.mode === "print" || !ctx.hasUI) {
        ctx.ui.notify(formatRulesStatus(runtime.snapshot()), command && command !== "status" ? "warning" : "info");
        if (command && command !== "status") ctx.ui.notify("用法: /auto-compact [status|clear]", "warning");
        return;
      }
      if (command) {
        ctx.ui.notify("用法: /auto-compact [status|clear]", "warning");
        return;
      }
      const edited = await ctx.ui.custom<AutoCompactRule[] | null>(
        (_tui, _theme, _keybindings, done) => new AutoCompactPanel(runtime.snapshot(), done),
        { overlay: true, overlayOptions: { anchor: "center", width: 72 } },
      );
      if (!edited) return;
      runtime.save(edited, ctx);
      hud.render();
      ctx.ui.notify(`已保存 ${edited.length} 条自动压缩策略`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.restore(ctx);
    hud.render();
  });
  pi.on("session_shutdown", () => runtime.stop());
  pi.on("input", (_event, ctx) => runtime.onActivity(ctx));
  pi.on("agent_start", (_event, ctx) => runtime.onBusy(ctx));
  pi.on("agent_settled", (_event, ctx) => runtime.onSettled(ctx));
  pi.on("ui_prompt_start", () => runtime.onPrompt(true));
  pi.on("ui_prompt_end", (_event, ctx) => runtime.onPrompt(false, ctx));
  pi.on("session_before_compact", (event, ctx) => compactUsingCuprum(event, ctx));
  pi.on("session_compact", (_event, ctx) => runtime.onCompactFinished(ctx));
  pi.on("session_compact_failed", (_event, ctx) => runtime.onCompactFinished(ctx));
}
