import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aliasStore } from "./store.js";
import { parseProviderModelId } from "./types.js";

interface GlobalDefault {
  settings: SettingsManager;
  model: string | undefined;
}

type SyncContext = Pick<ExtensionContext, "cwd" | "ui">;
type ModelReference = { provider: string; id: string };

// DefaultModelSync 在一个扩展运行时内比较默认模型快照，仅同步配置，不切换当前模型。
export class DefaultModelSync {
  private initialized = false;
  private lastDefault: string | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  // initialize 启动或恢复时只记录基线，不对齐已有绑定。
  initialize(ctx: SyncContext): Promise<void> {
    return this.enqueue(() => {
      this.initialized = false;
      const current = readGlobalDefault(ctx);
      if (!current) return;
      this.lastDefault = current.model;
      this.initialized = true;
    });
  }

  // syncAgFromDefault 默认模型发生变化时更新 Ag，写入失败保留基线以便下次重试。
  syncAgFromDefault(ctx: SyncContext): Promise<void> {
    return this.enqueue(() => {
      const current = readGlobalDefault(ctx);
      if (!current) return;
      if (!this.initialized) {
        this.lastDefault = current.model;
        this.initialized = true;
        return;
      }
      if (current.model === this.lastDefault) return;
      if (current.model) {
        try {
          aliasStore.reload();
          if (aliasStore.get("Ag") !== current.model) {
            aliasStore.set("Ag", current.model);
            ctx.ui.notify(`默认模型已变更，Ag 已跟随 → ${current.model}`, "info");
          }
        } catch (error) {
          notifyFailure(ctx, "Ag 同步失败", error);
          return;
        }
      }
      this.lastDefault = current.model;
    });
  }

  // syncDefaultFromAg Ag 绑定后合并写入全局默认模型，成功后更新基线防止反向重复同步。
  syncDefaultFromAg(ctx: SyncContext, model: ModelReference): Promise<boolean> {
    return this.enqueue(async () => {
      const current = readGlobalDefault(ctx);
      if (!current) return false;
      const providerModelId = `${model.provider}/${model.id}`;
      try {
        if (current.model !== providerModelId) {
          current.settings.setDefaultModelAndProvider(model.provider, model.id);
          await current.settings.flush();
          const errors = current.settings.drainErrors();
          if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("；"));
        }
        this.lastDefault = providerModelId;
        this.initialized = true;
        return true;
      } catch (error) {
        notifyFailure(ctx, "Ag 已绑定，但默认模型同步失败", error);
        return false;
      }
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}

function readGlobalDefault(ctx: SyncContext): GlobalDefault | undefined {
  try {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("；"));
    const global = settings.getGlobalSettings();
    if (!global || typeof global !== "object" || Array.isArray(global)) throw new Error("settings 必须是对象");
    const { defaultProvider: provider, defaultModel: modelId } = global;
    if (provider === undefined || modelId === undefined) return { settings, model: undefined };
    if (typeof provider !== "string" || typeof modelId !== "string" || !parseProviderModelId(`${provider}/${modelId}`) || provider.includes("/")) {
      throw new Error("defaultProvider/defaultModel 格式无效");
    }
    return { settings, model: `${provider}/${modelId}` };
  } catch (error) {
    notifyFailure(ctx, "无法读取全局默认模型，本次不联动", error);
    return undefined;
  }
}

function notifyFailure(ctx: SyncContext, message: string, error: unknown): void {
  ctx.ui.notify(`${message}: ${error instanceof Error ? error.message : String(error)}`, "warning");
}
