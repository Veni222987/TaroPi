// source_check 工具：为一个断言收集网页证据，返回带来源、引用片段的结构化 artifact 供人工核验。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fetchAllContent } from "../fetch/index.ts";
import { normalizeProviderSelection, resolveRequestedProvider, search } from "../search/index.ts";
import { buildResearchArtifact, storeResearchArtifact, type ResearchArtifact } from "../research/source-check.ts";
import { SEARCH_PROVIDER_IDS, type SearchResult } from "../types.ts";

const ProviderSchema = Type.Union([StringEnum(["auto", ...SEARCH_PROVIDER_IDS] as const), Type.Array(StringEnum(SEARCH_PROVIDER_IDS), { minItems: 1 })], {
  description: `Search provider or list of providers to search simultaneously; supported: ${SEARCH_PROVIDER_IDS.join(", ")}`,
});

const SourceCheckParams = Type.Object({
  claim: Type.String({ description: "The assertion to gather web sources for." }),
  queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries (default: the claim)." })),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." })),
  fetchContent: Type.Optional(Type.Boolean({ description: "Fetch up to 5 result pages for exact passage extraction." })),
  recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Filter by recency." })),
  domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude." })),
  provider: Type.Optional(ProviderSchema),
});

function formatArtifact(artifact: ResearchArtifact): string {
  const lines = [`# Source check: ${artifact.query}`, ""];
  if (artifact.summary) lines.push(artifact.summary, "");
  lines.push("## Sources");
  for (const source of artifact.sources) {
    lines.push(`${source.rank}. [${source.quality}] ${source.title} (${source.url})${source.fetched === false ? " — fetch failed" : ""}`);
  }
  if (artifact.passages.length > 0) {
    lines.push("", "## Passages");
    for (const passage of artifact.passages) lines.push(`- [${passage.passage_id}] (${passage.source_url}) ${passage.text}`);
  }
  lines.push("", `Evidence gathered; claims are NOT auto-verified. Review passages manually. Use get_search_content({ responseId: "${artifact.id}" }) for the full artifact.`);
  return lines.join("\n");
}

/** createSourceCheckTool 构造 source_check 工具定义 */
export function createSourceCheckTool(): ToolDefinition<typeof SourceCheckParams> {
  return {
    name: "source_check",
    label: "Source Check",
    description: "Gather web sources for a claim and return a bounded machine-readable research artifact with exact passage citations for manual review.",
    promptSnippet: "Gather structured source evidence and passage-level citations for manual semantic review of a claim.",
    parameters: SourceCheckParams,
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const claim = params.claim.trim();
      if (!claim) return { content: [{ type: "text", text: "Error: 'claim' is required." }], details: { error: "Missing claim" } };

      let provider: ReturnType<typeof resolveRequestedProvider>;
      try {
        provider = params.provider !== undefined ? normalizeProviderSelection(params.provider) : resolveRequestedProvider(undefined);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
      }

      const queries = (params.queries?.map((q) => q.trim()).filter(Boolean).length ? params.queries!.map((q) => q.trim()).filter(Boolean) : [claim]).slice(0, 8);
      const numResults = params.numResults ?? 5;
      const resultsByUrl = new Map<string, SearchResult>();
      const summaries: string[] = [];
      const errors: Array<{ query: string; error: string }> = [];
      let usedProvider: string | undefined;

      for (const query of queries) {
        if (signal?.aborted) break;
        try {
          const response = await search(query, { numResults, recencyFilter: params.recencyFilter, domainFilter: params.domainFilter, signal }, provider, ctx);
          usedProvider ??= response.provider;
          if (response.answer) summaries.push(`${query}: ${response.answer}`);
          for (const result of response.results) if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
        } catch (err) {
          if (signal?.aborted) break;
          errors.push({ query, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const results = [...resultsByUrl.values()].slice(0, 20);
      let fetched: Awaited<ReturnType<typeof fetchAllContent>> = [];
      if (params.fetchContent && results.length > 0) {
        const urls = results.slice(0, 5).map((r) => r.url);
        try {
          fetched = await fetchAllContent(urls, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          fetched = urls.map((url) => ({ url, title: "", content: "", error: err instanceof Error ? err.message : String(err) }));
        }
      }

      const artifact = buildResearchArtifact({ query: claim, provider: usedProvider, summary: summaries.length ? summaries.join("\n\n") : undefined, results, fetched, errors: errors.length ? errors : undefined });
      storeResearchArtifact(artifact);

      return {
        content: [{ type: "text", text: formatArtifact(artifact) }],
        details: { responseId: artifact.id, sourceCount: artifact.sources.length, passageCount: artifact.passages.length },
      };
    },
  };
}
