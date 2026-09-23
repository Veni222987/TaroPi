import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findModelByProviderModelId,
  findModelsById,
  modelsToChoices,
  parseProviderModelId,
  type AliasTier,
} from "./types.js";
import { TIER_LABEL } from "./types.js";
import { aliasStore, resolveModelAlias } from "./store.js";
import { AliasSettingsPage, ModelPickerPage } from "./ui.js";

export { resolveModelAlias } from "./store.js";

/**
 * 注册 /model-alias 命令与模块
 *
 * 用法：
 *   /model-alias           → 打开 TUI 设置页（三步：选档位 → 选模型 → 确认绑定）
 *   /model-alias Au qq/gpt-5  → 直接绑定 Au 档位到 qq/gpt-5（print mode 兼容）
 */
export function register(pi: ExtensionAPI): void {
  pi.registerCommand("model-alias", {
    description: "设置三档模型别名（参数使用 provider/model-id）",
    handler: async (args, ctx) => {
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

        const resolvedProviderModelId = `${matched.provider}/${matched.id}`;
        aliasStore.set(tier, resolvedProviderModelId);
        ctx.ui.notify(`${TIER_LABEL[tier]} → ${resolvedProviderModelId}  ✅`, "info");
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

      await openTuiSettings(ctx);
    },
  });

  // session_start 时热重载 alias 文件（支持外部直接修改后即时生效）
  pi.on("session_start", async () => {
    aliasStore.reload();
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

// ─── TUI 交互 ─────────────────────────────────────────────────

async function openTuiSettings(ctx: any): Promise<void> {
  // 第一层：选择档位
  const tier: AliasTier | null = await ctx.ui.custom(
    (_tui: any, _theme: any, _keybindings: any, done: any) => new AliasSettingsPage(
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
  const providerModelId: string | null = await ctx.ui.custom(
    (tui: any, _theme: any, _keybindings: any, done: any) => {
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

  aliasStore.set(tier, providerModelId);
  ctx.ui.notify(`${TIER_LABEL[tier]} → ${providerModelId}  ✅`, "info");
}
