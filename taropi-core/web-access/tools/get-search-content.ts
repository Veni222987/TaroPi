// get_search_content 工具：按 responseId 检索之前 web_search / fetch_content / source_check 存储的内容，支持分页与文本查找。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadWebSearchConfig, resolveMaxInlineContentChars } from "../config.ts";
import { findContent, type FindMode } from "../content/find.ts";
import { getResult, type QueryResultData } from "../content/storage.ts";
import { getResearchArtifact } from "../research/source-check.ts";

const GetSearchContentParams = Type.Object({
  responseId: Type.String({ description: "The responseId from web_search, fetch_content, or source_check" }),
  query: Type.Optional(Type.String({ description: "Get content for this search query" })),
  queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
  url: Type.Optional(Type.String({ description: "Get content for this URL" })),
  urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for content slices (default 0). Ignored when findText is supplied." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters to return. Ignored when findText is supplied." })),
  findText: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 })], { description: "Text or texts to find in the selected stored content" })),
  findMode: Type.Optional(StringEnum(["exact", "case-insensitive", "fuzzy"] as const, { description: "Matching mode for findText (default: case-insensitive)" })),
});

function formatFullResults(queryData: QueryResultData): string {
  const lines = [`Query: ${queryData.query}`, `Provider: ${queryData.provider ?? "unknown"}`, `Answer: ${queryData.answer || "(no answer text returned)"}`, "", "Sources:"];
  queryData.results.forEach((r, i) => lines.push(`${i + 1}. ${r.title} (${r.url})${r.snippet ? `\n   ${r.snippet}` : ""}`));
  return lines.join("\n");
}

/** createGetSearchContentTool 构造 get_search_content 工具定义 */
export function createGetSearchContentTool(): ToolDefinition<typeof GetSearchContentParams> {
  return {
    name: "get_search_content",
    label: "Get Search Content",
    description: "Retrieve bounded content slices or find matching passages in a previous web_search, fetch_content, or source_check call.",
    promptSnippet: "Use after web_search/fetch_content/source_check to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.",
    parameters: GetSearchContentParams,
    async execute(_callId, params) {
      const findMode: FindMode = (params.findMode as FindMode) ?? "case-insensitive";
      const findQueries = params.findText === undefined ? undefined : Array.isArray(params.findText) ? params.findText : [params.findText];

      const data = getResult(params.responseId);
      if (!data) {
        return { content: [{ type: "text", text: `Error: No stored results for responseId "${params.responseId}".` }], details: { error: "Not found", responseId: params.responseId } };
      }

      if (data.type === "research") {
        const artifact = getResearchArtifact(params.responseId);
        if (!artifact) return { content: [{ type: "text", text: "Error: stored research artifact not found." }], details: { error: "Artifact not found" } };
        const serialized = JSON.stringify(artifact, null, 2);
        return respondWithSlice(serialized, params, findQueries, findMode, { responseId: artifact.id, type: "research" });
      }

      if (data.type === "search" && data.queries) {
        const queryData = params.query !== undefined
          ? data.queries.find((q) => q.query === params.query)
          : params.queryIndex !== undefined ? data.queries[params.queryIndex] : undefined;
        if (!queryData) {
          const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
          return { content: [{ type: "text", text: `Error: query not found. Available: ${available || "none"}.` }], details: { error: "Query not found" } };
        }
        if (queryData.error) return { content: [{ type: "text", text: `Error retrieving query "${queryData.query}": ${queryData.error}` }], details: { error: queryData.error } };
        return respondWithSlice(formatFullResults(queryData), params, findQueries, findMode, { query: queryData.query, resultCount: queryData.results.length });
      }

      if (data.type === "fetch" && data.urls) {
        const urlData = params.url !== undefined
          ? data.urls.find((u) => u.url === params.url)
          : params.urlIndex !== undefined ? data.urls[params.urlIndex] : undefined;
        if (!urlData) {
          const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
          return { content: [{ type: "text", text: `Error: URL not found. Available:\n  ${available || "none"}` }], details: { error: "URL not found" } };
        }
        if (urlData.error) return { content: [{ type: "text", text: `Error retrieving URL "${urlData.url}": ${urlData.error}` }], details: { error: urlData.error } };
        return respondWithSlice(urlData.content, params, findQueries, findMode, { url: urlData.url, title: urlData.title }, `# ${urlData.title || urlData.url}\n\n`);
      }

      return { content: [{ type: "text", text: `Error: invalid stored data for responseId "${params.responseId}".` }], details: { error: "Invalid data" } };
    },
  };
}

function respondWithSlice(
  content: string,
  params: { offset?: number; limit?: number },
  findQueries: string[] | undefined,
  findMode: FindMode,
  baseDetails: Record<string, unknown>,
  prefix = "",
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  if (findQueries !== undefined) {
    try {
      const found = findContent(content, findQueries, findMode);
      const { text, ...findDetails } = found;
      return { content: [{ type: "text", text: `${prefix}${text}` }], details: { ...baseDetails, findMode, ...findDetails } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Unable to find text: ${error}` }], details: { ...baseDetails, error } };
    }
  }
  const maxInlineChars = resolveMaxInlineContentChars(loadWebSearchConfig());
  const offset = params.offset ?? 0;
  const limit = params.limit ?? maxInlineChars;
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) {
    return { content: [{ type: "text", text: `Error: offset out of range (0-${content.length}).` }], details: { ...baseDetails, error: "Offset out of range" } };
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return { content: [{ type: "text", text: "Error: limit must be a positive integer." }], details: { ...baseDetails, error: "Invalid limit" } };
  }
  const endOffset = Math.min(offset + limit, content.length);
  const slice = content.slice(offset, endOffset);
  const hasMore = endOffset < content.length;
  let text = `${prefix}${slice}`;
  if (hasMore || offset > 0) text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${content.length}.${hasMore ? ` Use offset: ${endOffset} for the next slice.` : ""}`;
  return { content: [{ type: "text", text }], details: { ...baseDetails, contentLength: content.length, offset, limit, returnedChars: slice.length, truncated: hasMore } };
}
