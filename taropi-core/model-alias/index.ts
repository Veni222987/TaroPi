import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelsToChoices, type AliasTier } from "./types.js";
import { TIER_LABEL } from "./types.js";
import { aliasStore, resolveModelAlias } from "./store.js";
import { AliasSettingsPage, ModelPickerPage } from "./ui.js";

export { resolveModelAlias } from "./store.js";

/**
 * 注册 /model-alias 命令与模块
 *
 * 用法：
 *   /model-alias           → 打开 TUI 设置页（三步：选档位 → 选模型 → 确认绑定）
 *   /model-alias Au gpt-5  → 直接绑定 Au 档位到 gpt-5（print mode 兼容）
 */
export function register(pi: ExtensionAPI): void {
  pi.registerCommand("model-alias", {
    description: "设置三档模型别名（Au/金·Ag/银·Cu/铜），影响 plan/sub-agent 等插件",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // 直接参数模式：/model-alias <tier> <modelPattern>
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

        const pattern = rest.join(" ");
        if (!pattern) {
          // 只给了档位 → 显示当前绑定
          const bound = aliasStore.get(tier);
          ctx.ui.notify(`${TIER_LABEL[tier]} → ${bound ?? "(未设置)"}`, "info");
          return;
        }

        // 按 pattern 匹配模型
        const models = ctx.modelRegistry.getAvailable();
        const matched = findModelByPattern(models, pattern);
        if (!matched) {
          ctx.ui.notify(`未匹配到模型: ${pattern}`, "error");
          return;
        }

        const providerModelId = `${matched.provider}/${matched.id}`;
        aliasStore.set(tier, providerModelId);
        ctx.ui.notify(`${TIER_LABEL[tier]} → ${providerModelId}  ✅`, "info");
        return;
      }

      // TUI 模式：打开设置弹窗
      if (ctx.mode === "print") {
        ctx.ui.notify(
          "print 模式下请使用参数形式: /model-alias <Au|Ag|Cu> <模型名>",
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

/** 按 pattern 模糊匹配模型（匹配 id 或 name） */
function findModelByPattern(
  models: { id: string; name: string; provider: string }[],
  pattern: string,
): { id: string; name: string; provider: string } | undefined {
  const lower = pattern.toLowerCase();
  // 精确匹配 provider/id
  const exactProviderId = models.find(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === lower,
  );
  if (exactProviderId) return exactProviderId;
  // id 匹配
  const byId = models.find((m) => m.id.toLowerCase().includes(lower));
  if (byId) return byId;
  // name 匹配
  const byName = models.find((m) => m.name.toLowerCase().includes(lower));
  if (byName) return byName;
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
      overlayOptions: {
        anchor: "center",
        width: "50%",
        minWidth: 40,
      },
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
  const providerModelId: string | null = await ctx.ui.custom(
    (_tui: any, _theme: any, _keybindings: any, done: any) => new ModelPickerPage(
      choices,
      tier,
      (id) => done(id),
      () => done(null),
    ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "60%",
        minWidth: 40,
        maxHeight: "80%",
      },
    },
  );

  if (!providerModelId) return; // 用户取消

  aliasStore.set(tier, providerModelId);
  ctx.ui.notify(`${TIER_LABEL[tier]} → ${providerModelId}  ✅`, "info");
}
