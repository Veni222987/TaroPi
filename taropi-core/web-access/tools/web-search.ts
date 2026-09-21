// web_search 工具：批量执行搜索查询，自动选源（Exa -> Brave -> OpenAI，Codex 会话优先 OpenAI）或显式指定 provider。
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadWebSearchConfig, resolveMaxInlineContentChars } from "../config.ts";
import { fetchAllContent } from "../fetch/index.ts";
import { generateSearchSummary } from "../model/summary.ts";
import { normalizeProviderSelection, resolveRequestedProvider, search } from "../search/index.ts";
import { generateId, storeResult, type QueryResultData } from "../content/storage.ts";
import { SEARCH_PROVIDER_IDS, type SearchOptions } from "../types.ts";

function normalizeQueryList(raw: unknown[]): string[] {
  const normalized: string[] = [];
  for (const query of raw) {
    if (typeof query !== "string") continue;
    const trimmed = query.trim();
    if (trimmed) normalized.push(trimmed);
  }
  return normalized;
}

function normalizeRecencyFilter(value: unknown): SearchOptions["recencyFilter"] {
  return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}

async function runSearchQueries<T>(queries: string[], run: (query: string) => Promise<T>): Promise<T[]> {
  const CONCURRENCY = 3;
  const results: T[] = new Array(queries.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const current = index++;
      if (current >= queries.length) return;
      results[current] = await run(queries[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker));
  return results;
}

const ProviderSchema = Type.Union([
  StringEnum(["auto", ...SEARCH_PROVIDER_IDS] as const),
  Type.Array(StringEnum(SEARCH_PROVIDER_IDS), { minItems: 1 }),
], { description: `Search provider or list of providers to search simultaneously; supported: ${SEARCH_PROVIDER_IDS.join(", ")}. Omit to use the configured default.` });

const WebSearchParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
  queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched concurrently, each returning source-linked results. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries." })),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
  includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content in the background for each result" })),
  recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Filter by recency" })),
  domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
  provider: Type.Optional(ProviderSchema),
  workflow: Type.Optional(StringEnum(["none", "auto-summary"] as const, { description: "none (default) = return raw results; auto-summary = generate a summary using the current Pi model without interactive review" })),
});

/** createWebSearchTool 构造 web_search 工具定义 */
export function createWebSearchTool(): ToolDefinition<typeof WebSearchParams> {
  return {
    name: "web_search",
    label: "Web Search",
    description: `Search the web with Brave, Exa, or OpenAI. Provider arrays run simultaneously. By default, returns source-linked search results or provider answers. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query. When includeContent is true, full page content is fetched in the background. Set workflow to "auto-summary" to generate a summary using the current Pi model. The configured provider is used when provider is omitted or set to auto.`,
    promptSnippet: "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage. Omit provider unless explicitly overriding the configured default.",
    parameters: WebSearchParams,
    async execute(_callId, params, signal, onUpdate, ctx) {
      const rawQueryList = Array.isArray(params.queries) ? params.queries : params.query !== undefined ? [params.query] : [];
      const queryList = normalizeQueryList(rawQueryList);
      if (queryList.length === 0) {
        return { content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }], details: { error: "No query provided" } };
      }

      let provider: ReturnType<typeof resolveRequestedProvider>;
      try {
        provider = params.provider !== undefined ? normalizeProviderSelection(params.provider) : resolveRequestedProvider(undefined);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
      }

      const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
      let completed = 0;
      const queryResponses = await runSearchQueries(queryList, async (query) => {
        signal?.throwIfAborted();
        onUpdate?.({ content: [{ type: "text", text: `Searching "${query}" (${completed}/${queryList.length} complete)...` }], details: { phase: "search", progress: completed / queryList.length } });
        try {
          const response = await search(query, {
            numResults: params.numResults,
            recencyFilter,
            domainFilter: params.domainFilter,
            includeContent: params.includeContent,
            signal,
          }, provider, ctx);
          return { query, answer: response.answer, results: response.results, error: null, provider: response.provider } satisfies QueryResultData;
        } catch (err) {
          if (signal?.aborted) throw err;
          const message = err instanceof Error ? err.message : String(err);
          return { query, answer: "", results: [], error: message } satisfies QueryResultData;
        } finally {
          completed++;
        }
      });

      const allUrls: string[] = [];
      for (const response of queryResponses) for (const result of response.results) if (!allUrls.includes(result.url)) allUrls.push(result.url);

      let inlineContentText = "";
      if (params.includeContent && allUrls.length > 0) {
        try {
          const fetched = await fetchAllContent(allUrls, signal);
          inlineContentText = fetched.map((f) => (f.error ? `\n\n### ${f.url}\nError: ${f.error}` : `\n\n### ${f.title || f.url}\n${f.content.slice(0, 5000)}`)).join("");
        } catch {
          // includeContent 失败不影响搜索结果本身
        }
      }

      let summaryText: string | undefined;
      let summaryMeta: { model: string | null; fallbackUsed: boolean } | undefined;
      if (params.workflow === "auto-summary" && ctx) {
        onUpdate?.({ content: [{ type: "text", text: "Generating summary..." }], details: { phase: "generating-summary" } });
        const generated = await generateSearchSummary(queryResponses, ctx, signal);
        summaryText = generated.summary;
        summaryMeta = generated.meta;
      }

      const responseId = generateId();
      storeResult(responseId, { id: responseId, type: "search", timestamp: Date.now(), queries: queryResponses });

      const successfulQueries = queryResponses.filter((r) => !r.error).length;
      const totalResults = queryResponses.reduce((sum, r) => sum + r.results.length, 0);
      const maxInlineChars = resolveMaxInlineContentChars(loadWebSearchConfig());

      const outputSections = queryResponses.map((r) => {
        if (r.error) return `## "${r.query}"\nError: ${r.error}`;
        const sourceLines = r.results.map((s, i) => `${i + 1}. ${s.title} (${s.url})${s.snippet ? `\n   ${s.snippet}` : ""}`).join("\n");
        return `## "${r.query}" (${r.provider ?? "unknown"})\n${r.answer || "(no answer text returned)"}\n\nSources:\n${sourceLines || "  none"}`;
      });
      let text = outputSections.join("\n\n");
      if (summaryText) text = `# Summary\n\n${summaryText}\n\n---\n\n${text}`;
      if (inlineContentText) text += `\n\n---\nFetched content:${inlineContentText}`;
      if (text.length > maxInlineChars) text = `${text.slice(0, maxInlineChars)}\n\n---\nTruncated at ${maxInlineChars} chars. Use get_search_content({ responseId: "${responseId}" }) to retrieve more.`;

      return {
        content: [{ type: "text", text }],
        details: { responseId, queryCount: queryList.length, successfulQueries, totalResults, ...(summaryMeta ? { summary: summaryMeta } : {}) },
      } satisfies AgentToolResult<Record<string, unknown>>;
    },
  };
}
