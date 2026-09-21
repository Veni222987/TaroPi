// 搜索 provider 统一接口：新增来源只需实现该接口并注册到 registry.ts。
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SearchOptions, SearchResponse } from "../types.ts";

/** provider 执行搜索时可用的 Pi 扩展上下文（当前模型、模型认证等），来自 tools 层透传 */
export type SearchProviderContext = Pick<ExtensionContext, "model" | "modelRegistry">;

/** provider 可用性 + 搜索执行的最小契约 */
export interface SearchProvider {
  readonly id: "brave" | "exa" | "openai";
  readonly label: string;
  /** isAvailable 判断当前是否具备可用的凭据/接入方式 */
  isAvailable(ctx?: SearchProviderContext): boolean | Promise<boolean>;
  /** search 执行搜索，凭据缺失时抛出说明性错误 */
  search(query: string, options: SearchOptions, ctx?: SearchProviderContext): Promise<SearchResponse>;
}
