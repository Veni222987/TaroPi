import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AliasConfig, AliasTier } from "./types.js";
import { TIER_ALIAS } from "./types.js";

const ALIAS_FILE = "model-aliases.json";

function aliasPath(): string {
  return path.join(getAgentDir(), ALIAS_FILE);
}

/** 读取持久化的别名配置（文件不存在时返回空对象） */
function loadFromFile(): AliasConfig {
  try {
    const raw = fs.readFileSync(aliasPath(), "utf-8");
    return JSON.parse(raw) as AliasConfig;
  } catch {
    return {};
  }
}

/** 写入别名配置文件 */
function saveToFile(config: AliasConfig): void {
  fs.mkdirSync(path.dirname(aliasPath()), { recursive: true });
  fs.writeFileSync(aliasPath(), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 模型别名存储（模块级单例，懒加载）
 * - 三档别名：Au (Aurum/金) / Ag (Argentum/银) / Cu (Cuprum/铜)
 * - 持久化到 ~/.pi/agent/model-aliases.json
 */
class ModelAliasStore {
  private config: AliasConfig = {};
  private loaded = false;

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.config = loadFromFile();
      this.loaded = true;
    }
  }

  /** 获取某个档位绑定的 provider/modelId */
  get(tier: AliasTier): string | undefined {
    this.ensureLoaded();
    return this.config[tier];
  }

  /** 获取全部别名配置 */
  getAll(): AliasConfig {
    this.ensureLoaded();
    return { ...this.config };
  }

  /** 设置某个档位的模型绑定 */
  set(tier: AliasTier, providerModelId: string): void {
    this.ensureLoaded();
    this.config[tier] = providerModelId;
    saveToFile(this.config);
  }

  /** 清除某个档位的绑定 */
  clear(tier: AliasTier): void {
    this.ensureLoaded();
    delete this.config[tier];
    saveToFile(this.config);
  }

  /**
   * 根据别名名解析为 provider/modelId 格式。
   * 支持三档别名名（Aurum/Argentum/Cuprum）以及 Au/Ag/Cu 缩写。
   * 找不到则返回 undefined。
   */
  resolve(name: string): string | undefined {
    this.ensureLoaded();
    // 先按 tier key 精确匹配
    for (const tier of ["Au", "Ag", "Cu"] as AliasTier[]) {
      if (name === tier) return this.config[tier];
    }
    // 再按全称匹配 (sub-agent 的 model 字段用的是全称)
    const tier = TIER_ALIAS[name];
    if (tier) return this.config[tier];
    return undefined;
  }

  /** 重载（从文件重新读取） */
  reload(): void {
    this.config = loadFromFile();
    this.loaded = true;
  }
}

/** 全局单例 */
export const aliasStore = new ModelAliasStore();

/**
 * 导出版本：根据 model 名称（如 "Aurum" / "Au"）解析为 "provider/id" 格式。
 * 供 sub-agent engine、plan 等模块使用。
 */
export function resolveModelAlias(modelName: string): string | undefined {
  return aliasStore.resolve(modelName);
}
