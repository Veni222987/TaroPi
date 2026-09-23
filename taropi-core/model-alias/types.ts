import type { Model } from "@earendil-works/pi-ai";

/** 三档别名键 */
export type AliasTier = "Au" | "Ag" | "Cu";

/** 档位显示名 */
export const TIER_LABEL: Record<AliasTier, string> = {
  Au: "🥇 Aurum (金)",
  Ag: "🥈 Argentum (银)",
  Cu: "🥉 Cuprum (铜)",
};

/** 档位别名全称映射 */
export const TIER_ALIAS: Record<string, AliasTier> = {
  Aurum: "Au",
  Argentum: "Ag",
  Cuprum: "Cu",
};

/** 持久化的别名配置 */
export interface AliasConfig {
  Au?: string; // provider/modelId，如 "anthropic/claude-sonnet-4"
  Ag?: string;
  Cu?: string;
}

/** provider/model-id 解析结果 */
export interface ProviderModelId {
  provider: string;
  modelId: string;
}

/** 模型选择项（渲染用） */
export interface ModelChoice {
  /** provider/model-id 格式 */
  providerModelId: string;
  /** 模型原始 id */
  id: string;
  /** 模型原始 name */
  name: string;
  /** provider 名 */
  provider: string;
}

// parseProviderModelId 解析严格的 provider/model-id 格式。
export function parseProviderModelId(raw: string): ProviderModelId | undefined {
  const parts = raw.split("/");
  if (parts.length !== 2) return undefined;

  const [provider, modelId] = parts;
  if (
    !provider ||
    !modelId ||
    /\s/.test(provider) ||
    /\s/.test(modelId)
  ) {
    return undefined;
  }

  return { provider, modelId };
}

// findModelByProviderModelId 按 provider/model-id 精确查找模型。
export function findModelByProviderModelId<T extends { provider: string; id: string }>(
  models: readonly T[],
  providerModelId: string,
): T | undefined {
  const parsed = parseProviderModelId(providerModelId);
  if (!parsed) return undefined;

  const provider = parsed.provider.toLowerCase();
  const modelId = parsed.modelId.toLowerCase();
  return models.find(
    (model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId,
  );
}

// findModelsById 查找指定 model-id 的全部 provider 模型。
export function findModelsById<T extends { id: string }>(models: readonly T[], id: string): T[] {
  const normalizedId = id.toLowerCase();
  return models.filter((model) => model.id.toLowerCase() === normalizedId);
}

// modelsToChoices 将 Model 列表转换为供模型选择页渲染的选项。
export function modelsToChoices(models: Model<any>[]): ModelChoice[] {
  return models.map((model) => ({
    providerModelId: `${model.provider}/${model.id}`,
    id: model.id,
    name: model.name,
    provider: model.provider,
  }));
}
