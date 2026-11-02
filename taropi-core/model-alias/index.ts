import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  findModelByProviderModelId,
  findModelsById,
  modelsToChoices,
  parseProviderModelId,
  type AliasTier,
} from "./types.js";
import { TIER_LABEL } from "./types.js";
import { aliasStore } from "./store.js";
import { DefaultModelSync } from "./default-sync.js";
import { AliasSettingsPage, ModelPickerPage } from "./ui.js";

export { resolveModelAlias } from "./store.js";

// register 注册 /model-alias 命令和 Ag 与全局默认模型的双向联动。
export function register(pi: ExtensionAPI): void {
  const defaultSync = new DefaultModelSync();
  pi.registerCommand("model-alias", {
    description: "设置三档模型别名（参数使用 provider/model-id）",
    handler: async (args, ctx) => {
      await defaultSync.syncAgFromDefault(ctx);
      const trimmed = args.trim();

      // 直接参数模式：/model-alias <tier> <provider/model-id>
      if (trimmed) {
        const [tierArg, ...rest] = trimmed.split(/\s+/);
        const tier = normalizeTier(tierArg!);
        if (!tier) {
          ctx.ui.notify(
            `无效档位: ${tierArg}。可用: Au / Ag / Cu（或 Aurum / Argentum / Cuprum）`,
            "error",
          );
          return;
        }

        const providerModelId = rest.join(" ");
        if (!providerModelId) {
          // 只给了档位 → 显示当前绑定
          const bound = aliasStore.get(tier);
          ctx.ui.notify(`${TIER_LABEL[tier]} → ${bound ?? "(未设置)"}`, "info");
          return;
        }

        const parsed = parseProviderModelId(providerModelId);
        if (!parsed) {
          ctx.ui.notify(
            "模型格式无效。请使用 provider/model-id，例如: qq/gpt-5",
            "error",
          );
          return;
        }

        const models = ctx.modelRegistry.getAvailable();
        const matched = findModelByProviderModelId(models, providerModelId);
        if (!matched) {
          const candidates = findModelsById(models, parsed.modelId)
            .map((model) => `${model.provider}/${model.id}`)
            .join("、");
          const candidateHint = candidates ? `。相同 model-id 可选: ${candidates}` : "";
          ctx.ui.notify(`未匹配到模型: ${providerModelId}${candidateHint}`, "error");
          return;
        }

        await bindTier(ctx, tier, matched, defaultSync);
        return;
      }

      // TUI 模式：打开设置弹窗
      if (ctx.mode === "print") {
        ctx.ui.notify(
          "print 模式下请使用参数形式: /model-alias <Au|Ag|Cu> <provider/model-id>",
          "warning",
        );
        return;
      }

      await openTuiSettings(ctx, defaultSync);
    },
  });

  // 启动与恢复仅重载绑定和记录基线，不改变用户已有配置。
  pi.on("session_start", async (_event, ctx) => {
    aliasStore.reload();
    await defaultSync.initialize(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    await defaultSync.syncAgFromDefault(ctx);
  });
  // 对当前模型按 Ctrl+S 不会发出 model_select，下次输入时补检查。
  pi.on("input", async (_event, ctx) => {
    await defaultSync.syncAgFromDefault(ctx);
  });
}

// ─── 内部辅助 ─────────────────────────────────────────────────

function normalizeTier(raw: string): AliasTier | undefined {
  const lower = raw.toLowerCase();
  if (lower === "au" || lower === "aurum") return "Au";
  if (lower === "ag" || lower === "argentum") return "Ag";
  if (lower === "cu" || lower === "cuprum") return "Cu";
  return undefined;
}

async function bindTier(
  ctx: ExtensionCommandContext,
  tier: AliasTier,
  model: { provider: string; id: string },
  defaultSync: DefaultModelSync,
): Promise<void> {
  const providerModelId = `${model.provider}/${model.id}`;
  try {
    aliasStore.reload();
    aliasStore.set(tier, providerModelId);
  } catch (error) {
    ctx.ui.notify(`模型别名绑定失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  const synced = tier === "Ag" && await defaultSync.syncDefaultFromAg(ctx, model);
  if (synced) {
    ctx.ui.notify(`${TIER_LABEL[tier]} → ${providerModelId}，默认配置已保存，正在重新加载使当前默认模型生效`, "info");
    // reload 会使当前 pi 和 ctx 失效，此后不再访问旧运行时，也不切换当前模型。
    await ctx.reload();
    return;
  }
  const hint = tier === "Ag" ? "，默认模型未同步" : "";
  ctx.ui.notify(`${TIER_LABEL[tier]} → ${providerModelId}${hint}  ✅`, "info");
}

// ─── TUI 交互 ─────────────────────────────────────────────────

async function openTuiSettings(ctx: ExtensionCommandContext, defaultSync: DefaultModelSync): Promise<void> {
  // 第一层：选择档位
  const tier = await ctx.ui.custom<AliasTier | null>(
    (_tui, _theme, _keybindings, done) => new AliasSettingsPage(
      { Au: aliasStore.get("Au"), Ag: aliasStore.get("Ag"), Cu: aliasStore.get("Cu") },
      (t) => done(t),
      () => done(null),
    ),
    {
      overlay: true,
      // 宽度必须与组件实际绘制宽度一致；百分比容器会让内容贴在容器左侧，视觉上偏左。
      overlayOptions: { anchor: "center", width: 56 },
    },
  );

  if (!tier) return; // 用户取消

  // 第二层：选择模型
  const allModels = ctx.modelRegistry.getAvailable();
  if (allModels.length === 0) {
    ctx.ui.notify(
      "暂无可选模型。请先配置 API key 或安装模型。",
      "error",
    );
    return;
  }

  const choices = modelsToChoices(allModels);
  let pickerWidth = 80;
  const providerModelId = await ctx.ui.custom<string | null>(
    (tui, _theme, _keybindings, done) => {
      pickerWidth = Math.min(80, Math.max(1, tui.terminal.columns - 4));
      return new ModelPickerPage(
        choices,
        tier,
        (id) => done(id),
        () => done(null),
      );
    },
    {
      overlay: true,
      // 宽度上限为 80；窄终端保留四列边距，避免覆盖终端边缘。
      overlayOptions: () => ({
        anchor: "center",
        width: pickerWidth,
        maxHeight: "80%",
      }),
    },
  );

  if (!providerModelId) return; // 用户取消

  const matched = findModelByProviderModelId(ctx.modelRegistry.getAvailable(), providerModelId);
  if (!matched) {
    ctx.ui.notify(`未匹配到模型: ${providerModelId}`, "error");
    return;
  }
  await bindTier(ctx, tier, matched, defaultSync);
}
