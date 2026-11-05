import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHudClient } from "taropi-hud/api";
import { compactUsingCuprum } from "./compactor.ts";
import { OfflineCompactSync } from "./offline.ts";
import { AutoCompactRuntime } from "./scheduler.ts";
import { formatAutoCompactHud, formatOfflineStatus, readCompactionStats, type CompactionStats } from "./stats.ts";
import { AUTO_COMPACT_ENTRY, formatRulesStatus, type AutoCompactRule } from "./types.ts";
import { AutoCompactPanel } from "./ui.ts";

// registerAutoCompact 注册 /auto-compact、会话级调度、离线压缩和铜牌模型压缩。
export function registerAutoCompact(pi: ExtensionAPI): void {
  let active: ExtensionContext | ExtensionCommandContext | undefined;
  const sync = new OfflineCompactSync({ warn: (message) => active?.ui.notify(message, "warning") });
  const runtime = new AutoCompactRuntime(
    (rules) => {
      pi.appendEntry(AUTO_COMPACT_ENTRY, { rules });
    },
    {
      onRulesSaved: (rules, ctx) => void sync.save(rules, ctx),
      onActivity: (ctx) => void sync.recordActivity(ctx),
      onCompacted: (ctx) => void sync.recordCompacted(ctx),
    },
  );
  let compactionStats: CompactionStats = { count: 0 };
  const rememberCompactions = (ctx: { sessionManager: { getBranch(): readonly { type?: string; timestamp?: string }[] } }) => {
    compactionStats = readCompactionStats(ctx.sessionManager.getBranch());
  };
  const hud = createHudClient(pi);
  hud.register({
    key: "auto-compact",
    refresh: () => undefined,
    render(_state, theme) {
      const text = formatAutoCompactHud(runtime.snapshot(), compactionStats);
      if (!text) return [];
      return [`${theme.c("🗜 auto-compact", theme.CYAN)} ${theme.dim(text)}`];
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

  pi.registerCommand("auto-compact-cron", {
    description: "查看或移除离线自动压缩的 cron 扫描任务",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "remove") {
        const result = await sync.removeCronTask();
        ctx.ui.notify(result.status === "failed" ? `移除失败：${result.message ?? "未知错误"}` : "已移除离线压缩 cron 任务", result.status === "failed" ? "warning" : "info");
        return;
      }
      if (command && command !== "status") {
        ctx.ui.notify("用法: /auto-compact-cron [status|remove]", "warning");
        return;
      }
      const status = await sync.status();
      ctx.ui.notify(formatOfflineStatus(status, Date.now()), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    active = ctx;
    runtime.restore(ctx);
    rememberCompactions(ctx);
    void sync.start(runtime.snapshot(), ctx);
    hud.render();
  });
  pi.on("session_shutdown", () => {
    runtime.stop();
    void sync.stop();
  });
  pi.on("input", (_event, ctx) => runtime.onActivity(ctx));
  pi.on("agent_start", (_event, ctx) => runtime.onBusy(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    runtime.onSettled(ctx);
    void sync.recordActivity(ctx);
  });
  pi.on("ui_prompt_start", () => runtime.onPrompt(true));
  pi.on("ui_prompt_end", (_event, ctx) => runtime.onPrompt(false, ctx));
  pi.on("session_before_compact", (event, ctx) => compactUsingCuprum(event, ctx));
  pi.on("session_compact", (_event, ctx) => {
    runtime.onCompactFinished(ctx);
    runtime.onCompacted(ctx);
    rememberCompactions(ctx);
    hud.render();
  });
  pi.on("session_tree", (_event, ctx) => {
    rememberCompactions(ctx);
    hud.render();
  });
  pi.on("session_compact_failed", (_event, ctx) => runtime.onCompactFinished(ctx));
}
