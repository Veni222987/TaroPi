// 搜索 provider 注册表：新增来源在此追加一个 SearchProvider 实现即可被自动选源和显式 provider 参数识别。
import { braveProvider } from "./brave.ts";
import { exaProvider, hasExaApiKey } from "./exa.ts";
import { openaiProvider } from "./openai.ts";
import type { SearchProvider, SearchProviderContext } from "./types.ts";

export type { SearchProvider, SearchProviderContext } from "./types.ts";
export { SEARCH_PROVIDER_IDS } from "../types.ts";
export type { SearchProviderId, SearchProviderSelection } from "../types.ts";

const PROVIDERS: readonly SearchProvider[] = [exaProvider, braveProvider, openaiProvider];

/** getSearchProvider 按 id 取回已注册的 provider 实现 */
export function getSearchProvider(id: string): SearchProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** getAllSearchProviders 返回全部已注册 provider，用于选源与可用性展示 */
export function getAllSearchProviders(): readonly SearchProvider[] {
  return PROVIDERS;
}

export { hasExaApiKey };
