// 搜索调度：解析 provider 选择参数、按配置/会话状态排序自动选源、执行显式/数组/自动三种模式。
import { loadWebSearchConfig } from "../config.ts";
import { getAllSearchProviders, getSearchProvider } from "../searchimpl/index.ts";
import type { SearchProviderContext } from "../searchimpl/types.ts";
import { SEARCH_PROVIDER_IDS, type AttributedSearchResponse, type SearchOptions, type SearchProviderId, type SearchProviderSelection, type SearchResult } from "../types.ts";

function isAbortError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

function isProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/** normalizeProviderSelection 解析工具参数或配置中的 provider 字段；非法值一律退回 "auto" */
export function normalizeProviderSelection(value: unknown): SearchProviderSelection {
  if (Array.isArray(value)) {
    const ids = value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase());
    const valid = ids.filter(isProviderId);
    if (valid.length === 0) throw new Error(`provider array must contain at least one of: ${SEARCH_PROVIDER_IDS.join(", ")}`);
    return valid;
  }
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "auto" || normalized === "") return "auto";
  if (isProviderId(normalized)) return normalized;
  throw new Error(`provider must be "auto", an array, or one of: ${SEARCH_PROVIDER_IDS.join(", ")}`);
}

function resolveConfiguredOrder(): SearchProviderId[] | undefined {
  const config = loadWebSearchConfig();
  const value = (config as { searchProviderOrder?: unknown }).searchProviderOrder;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("searchProviderOrder in web-search.json must be a non-empty array");
  }
  const order = value.map((v) => {
    const normalized = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (!isProviderId(normalized)) throw new Error(`searchProviderOrder in web-search.json contains an invalid provider: ${String(v)}`);
    return normalized;
  });
  return [...new Set(order)];
}

/** resolveRequestedProvider 解析工具调用最终使用的 provider 选择：参数优先，其次配置默认值 */
export function resolveRequestedProvider(paramProvider: unknown): SearchProviderSelection {
  if (paramProvider !== undefined) return normalizeProviderSelection(paramProvider);
  const config = loadWebSearchConfig();
  return normalizeProviderSelection((config as { provider?: unknown }).provider);
}

/** autoSearchOrder 默认 Exa 优先；当前会话为 OpenAI Codex 时优先 OpenAI；配置可覆盖整体顺序 */
export function autoSearchOrder(ctx?: SearchProviderContext): SearchProviderId[] {
  const configured = resolveConfiguredOrder();
  if (configured) return configured;
  const preferOpenAI = ctx?.model?.provider === "openai-codex";
  return preferOpenAI ? ["openai", "exa", "brave"] : ["exa", "brave", "openai"];
}

async function searchWithProvider(id: SearchProviderId, query: string, options: SearchOptions, ctx?: SearchProviderContext): Promise<AttributedSearchResponse> {
  const provider = getSearchProvider(id);
  if (!provider) throw new Error(`Unknown search provider: ${id}`);
  const response = await provider.search(query, options, ctx);
  return { ...response, provider: id };
}

async function searchAuto(query: string, options: SearchOptions, ctx?: SearchProviderContext): Promise<AttributedSearchResponse> {
  const order = autoSearchOrder(ctx);
  const errors: string[] = [];
  for (const id of order) {
    try {
      return await searchWithProvider(id, query, options, ctx);
    } catch (err) {
      if (isAbortError(err)) throw err;
      errors.push(`${getSearchProvider(id)?.label ?? id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No search provider available:\n  - ${errors.join("\n  - ")}`);
}

async function searchMultiple(ids: SearchProviderId[], query: string, options: SearchOptions, ctx?: SearchProviderContext): Promise<AttributedSearchResponse> {
  const settled = await Promise.allSettled(ids.map((id) => searchWithProvider(id, query, options, ctx)));
  if (options.signal?.aborted) throw new Error("Aborted");

  const successes: AttributedSearchResponse[] = [];
  const failures: Array<{ id: SearchProviderId; error: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") successes.push(outcome.value);
    else failures.push({ id: ids[i], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  if (successes.length === 0) {
    throw new Error(`Selected-provider search failed:\n  - ${failures.map((f) => `${getSearchProvider(f.id)?.label ?? f.id}: ${f.error}`).join("\n  - ")}`);
  }

  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const response of successes) {
    for (const result of response.results) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      results.push(result);
    }
  }
  const answerSections = successes.map((r) => `## ${getSearchProvider(r.provider)?.label ?? r.provider}\n\n${r.answer || "(No answer text returned.)"}`);
  if (failures.length > 0) {
    answerSections.push(`## Provider errors\n\n${failures.map((f) => `- **${getSearchProvider(f.id)?.label ?? f.id}:** ${f.error}`).join("\n")}`);
  }
  return { provider: successes[0].provider, answer: answerSections.join("\n\n"), results };
}

/** search 执行搜索：provider 为 "auto" 时按顺序回退；为数组时并发聚合；为单个 id 时直接执行且不静默换源 */
export async function search(query: string, options: SearchOptions, provider: SearchProviderSelection, ctx?: SearchProviderContext): Promise<AttributedSearchResponse> {
  if (Array.isArray(provider)) return searchMultiple(provider, query, options, ctx);
  if (provider === "auto") return searchAuto(query, options, ctx);
  return searchWithProvider(provider, query, options, ctx);
}

/** listSearchProviderAvailability 供 UI/诊断展示三个来源的当前可用性 */
export async function listSearchProviderAvailability(ctx?: SearchProviderContext): Promise<Record<SearchProviderId, boolean>> {
  const entries = await Promise.all(getAllSearchProviders().map(async (p) => [p.id, await p.isAvailable(ctx)] as const));
  return Object.fromEntries(entries) as Record<SearchProviderId, boolean>;
}
