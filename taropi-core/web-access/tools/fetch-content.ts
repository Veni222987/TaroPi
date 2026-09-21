// fetch_content 工具：抓取一个或多个 URL，支持 readable/raw/answer 三种模式与显式 authFetch 授权抓取。
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadWebSearchConfig, resolveFetchModeConfig, resolveMaxInlineContentChars } from "../config.ts";
import { fetchAllContent } from "../fetch/index.ts";
import { resolveAuthFetchProfile } from "../auth/auth-fetch.ts";
import { answerFromPage } from "../model/page-answer.ts";
import { generateId, storeFetchResult, type StoredSearchData } from "../content/storage.ts";
import type { ExtractedContent, ExtractOptions } from "../types.ts";

const FetchContentParams = Type.Object({
  url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
  forceClone: Type.Optional(Type.Boolean({ description: "Force cloning large GitHub repositories that exceed the size threshold" })),
  mode: Type.Optional(StringEnum(["readable", "raw", "answer"] as const, { description: "Fetch mode: readable = extract readable content as markdown (default), raw = return the exact textual body, answer = answer a prompt using only fetched content" })),
  prompt: Type.Optional(Type.String({ description: "Question to answer, required when mode is answer" })),
  answerModel: Type.Optional(Type.String({ description: "Optional provider/model-id override for answer mode. Defaults to fetch.answerProvider + fetch.answerModel when configured, otherwise the current Pi model." })),
  auth: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "Opt into an authFetch profile for local browser-cookie fetching. Use a profile name, or true only when exactly one profile exists." })),
  proxy: Type.Optional(Type.String({ description: "http(s) or socks proxy URL used for this fetch. Empty string forces direct access." })),
});

function normalizeUrlList(params: { url?: unknown; urls?: unknown }): string[] {
  const urls = Array.isArray(params.urls) ? params.urls.filter((u): u is string => typeof u === "string") : [];
  const single = typeof params.url === "string" ? [params.url] : [];
  return [...new Set([...urls, ...single].map((u) => u.trim()).filter(Boolean))];
}

function initialSlice(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  return { text: content.slice(0, maxChars), truncated: true };
}

/** createFetchContentTool 构造 fetch_content 工具定义 */
export function createFetchContentTool(): ToolDefinition<typeof FetchContentParams> {
  return {
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch URL(s). Supports readable/raw/answer modes, direct image URLs, GitHub repositories, and local PDF text extraction.",
    promptSnippet: "Use to fetch URL content, direct images, GitHub repos, and PDFs.",
    parameters: FetchContentParams,
    async execute(_callId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      const config = loadWebSearchConfig();
      let fetchModeConfig: ReturnType<typeof resolveFetchModeConfig>;
      try {
        fetchModeConfig = resolveFetchModeConfig(config);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
      }
      const mode = params.mode ?? fetchModeConfig.defaultMode;
      if (!fetchModeConfig.allowedModes.includes(mode)) {
        const error = `Fetch mode "${mode}" is disabled by fetch.allowedModes.`;
        return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
      }
      if (mode === "answer" && !params.prompt) {
        return { content: [{ type: "text", text: "Error: mode answer requires prompt." }], details: { error: "mode answer requires prompt" } };
      }
      if (mode === "raw" && (params.forceClone || params.prompt || params.answerModel || params.auth !== undefined)) {
        return { content: [{ type: "text", text: "Error: mode raw cannot be combined with forceClone, prompt, answerModel, or auth." }], details: { error: "Incompatible raw mode options" } };
      }
      if (mode === "answer" && params.auth !== undefined) {
        return { content: [{ type: "text", text: "Error: auth cannot be combined with mode answer." }], details: { error: "auth cannot be combined with mode answer" } };
      }

      let authFetchProfile: ReturnType<typeof resolveAuthFetchProfile> | undefined;
      if (params.auth !== undefined && params.auth !== false) {
        try {
          authFetchProfile = resolveAuthFetchProfile(params.auth === true ? true : String(params.auth));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
        }
      }

      const urlList = normalizeUrlList(params);
      if (urlList.length === 0) {
        return { content: [{ type: "text", text: "Error: No URL provided." }], details: { error: "No URL provided" } };
      }

      onUpdate?.({ content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }], details: { phase: "fetch", progress: 0 } });

      const extractOptions: ExtractOptions = {
        mode,
        forceClone: params.forceClone,
        proxy: typeof params.proxy === "string" && params.proxy ? params.proxy : undefined,
        auth: authFetchProfile,
        signal,
      };
      const fetchResults = await fetchAllContent(urlList, signal, extractOptions);

      const presentedResults: ExtractedContent[] = mode === "answer"
        ? await Promise.all(fetchResults.map(async (result) => {
          if (result.error) return result;
          if (result.thumbnail || result.mimeType?.startsWith("image/")) return { ...result, error: "Page answer requires textual fetched content" };
          if (!ctx) return { ...result, error: "Page answer requires an active extension context" };
          try {
            const answer = await answerFromPage({ question: params.prompt!, pageText: result.content, sourceUrl: result.url, ...(params.answerModel ? { model: params.answerModel } : {}) }, ctx, signal);
            return { ...result, content: answer.text };
          } catch (err) {
            return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }))
        : fetchResults;

      const successful = presentedResults.filter((r) => !r.error).length;
      const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);
      const responseId = generateId();
      const cacheable = !authFetchProfile || authFetchProfile.cache !== "off";
      if (cacheable) {
        try {
          storeFetchResult(responseId, { id: responseId, type: "fetch", timestamp: Date.now(), urls: fetchResults.map(({ thumbnail: _t, ...rest }) => rest) } satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] });
        } catch {
          // 缓存写入失败不影响本次抓取结果返回
        }
      }

      const maxInlineChars = resolveMaxInlineContentChars(config);

      if (urlList.length === 1) {
        const result = presentedResults[0];
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, ...(cacheable ? { responseId } : {}) } };
        }
        const slice = initialSlice(result.content, maxInlineChars);
        let output = slice.text;
        if (slice.truncated) {
          output += `\n\n---\nShowing ${slice.text.length} of ${result.content.length} chars. ${cacheable ? `Use get_search_content({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.text.length} }) for the next slice.` : "Authenticated fetch cache is off; repeat the fetch to read more."}`;
        }
        const content: AgentToolResult<Record<string, unknown>>["content"] = [];
        if (result.thumbnail) content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
        content.push({ type: "text", text: output });
        return {
          content,
          details: { urls: urlList, urlCount: 1, successful: 1, totalChars: result.content.length, title: result.title, ...(cacheable ? { responseId } : {}), truncated: slice.truncated, mode, mimeType: result.mimeType, status: result.status },
        };
      }

      let output = "## Fetched URLs\n\n";
      for (const { url, title, content, error } of presentedResults) {
        output += error ? `- ${url}: Error - ${error}\n` : `- ${title || url} (${content.length} chars)\n`;
      }
      output += cacheable ? `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.` : "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";
      return { content: [{ type: "text", text: output }], details: { urls: urlList, urlCount: urlList.length, successful, totalChars, ...(cacheable ? { responseId } : {}) } };
    },
  };
}
