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

/** 模型选择项 (渲染用) */
export interface ModelChoice {
  /** 展示标签：provider/id  name */
  label: string;
  /** provider/id 格式 */
  providerModelId: string;
  /** 模型原始 id */
  id: string;
  /** 模型原始 name */
  name: string;
  /** provider 名 */
  provider: string;
}

/** 从 Model 列表转换为 ModelChoice 列表 */
export function modelsToChoices(models: Model<any>[]): ModelChoice[] {
  return models.map((m) => ({
    label: `${m.id}  ${m.name !== m.id ? m.name : ""}`,
    providerModelId: `${m.provider}/${m.id}`,
    id: m.id,
    name: m.name,
    provider: m.provider,
  }));
}
