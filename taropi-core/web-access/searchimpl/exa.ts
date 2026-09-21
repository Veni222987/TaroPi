// Exa 搜索适配器：优先使用 API Key 调用官方 REST 接口；无 Key 时通过本机 mcporter
// 调用 Exa 托管 MCP（https://mcp.exa.ai/mcp）实现零配置搜索，不修改用户 mcporter 配置。
import { execFile } from "node:child_process";
import { loadWebSearchConfig, resolveApiBaseUrl } from "../config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "../credential.ts";
import { apiFetch } from "../network/request.ts";
import type { ExtractedContent, SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import type { SearchProvider } from "./types.ts";

const EXA_API_BASE_URL = "https://api.exa.ai";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_TIMEOUT_MS = 60_000;

function getApiKey(): string | null {
  const config = loadWebSearchConfig();
  return resolveCredential({ provider: "Exa", configuredValue: config.exaApiKey, environmentValue: process.env.EXA_API_KEY });
}

function getApiBaseUrl(): string {
  const config = loadWebSearchConfig();
  return resolveApiBaseUrl({
    configKey: "exaBaseUrl",
    configuredValue: config.exaBaseUrl,
    defaultValue: EXA_API_BASE_URL,
    environmentKey: "EXA_BASE_URL",
    environmentValue: process.env.EXA_BASE_URL,
  });
}

function recencyToStartDate(filter: string): string {
  const offsets: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  return new Date(Date.now() - (offsets[filter] ?? 0) * 86_400_000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
  if (!domainFilter?.length) return {};
  const includeDomains = domainFilter.filter((d) => !d.startsWith("-") && d.trim()).map((d) => d.trim());
  const excludeDomains = domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()).filter(Boolean);
  return { ...(includeDomains.length ? { includeDomains } : {}), ...(excludeDomains.length ? { excludeDomains } : {}) };
}

function mapApiResults(results: Array<{ title?: string; url?: string }> | undefined): SearchResult[] {
  if (!Array.isArray(results)) return [];
  return results.filter((r) => r.url).map((r, i) => ({ title: r.title || `Source ${i + 1}`, url: r.url as string, snippet: "" }));
}

function mapInlineContent(results: Array<{ title?: string; url?: string; text?: string }> | undefined): ExtractedContent[] {
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is { title?: string; url: string; text: string } => !!r.url && typeof r.text === "string" && r.text.length > 0)
    .map((r) => ({ url: r.url, title: r.title || "", content: r.text, error: null }));
}

function buildAnswerFromResults(results: Array<{ title?: string; url?: string; text?: string; highlights?: unknown }> | undefined): string {
  if (!results?.length) return "";
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item?.url) continue;
    const highlights = Array.isArray(item.highlights) ? item.highlights.filter((h): h is string => typeof h === "string") : [];
    const content = highlights.length > 0 ? highlights.join(" ") : typeof item.text === "string" ? item.text.trim().slice(0, 1000) : "";
    if (!content) continue;
    parts.push(`${content}\nSource: ${item.title || `Source ${i + 1}`} (${item.url})`);
  }
  return parts.join("\n\n");
}

async function searchWithApi(query: string, options: SearchOptions, apiKey: string): Promise<SearchResponse> {
  const apiBaseUrl = getApiBaseUrl();
  const headers = { "x-api-key": apiKey, "Content-Type": "application/json" };
  const useSearch = options.includeContent || !!options.recencyFilter || !!options.domainFilter?.length || !!(options.numResults && options.numResults !== 5);

  try {
    if (!useSearch) {
      const response = await apiFetch(`${apiBaseUrl}/answer`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      }, { timeoutMs: MCP_TIMEOUT_MS, signal: options.signal, credentialHeaders: ["x-api-key"] });
      if (!response.ok) {
        const errorText = redactCredential(await response.text(), apiKey);
        throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
      }
      const data = (await response.json()) as { answer?: string; citations?: Array<{ url?: string; title?: string }> };
      return { answer: data.answer || "", results: mapApiResults(data.citations) };
    }

    const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
    const response = await apiFetch(`${apiBaseUrl}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: options.numResults ?? 5,
        ...mapDomainFilter(options.domainFilter),
        ...(startDate ? { startPublishedDate: startDate } : {}),
        contents: options.includeContent ? { text: true, highlights: true } : { highlights: true },
      }),
    }, { timeoutMs: MCP_TIMEOUT_MS, signal: options.signal, credentialHeaders: ["x-api-key"] });
    if (!response.ok) {
      const errorText = redactCredential(await response.text(), apiKey);
      throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
    }
    const data = (await response.json()) as { results?: Array<{ title?: string; url?: string; text?: string; highlights?: unknown }> };
    return {
      answer: buildAnswerFromResults(data.results),
      results: mapApiResults(data.results),
      ...(options.includeContent ? { inlineContent: mapInlineContent(data.results) } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactCredential(message, apiKey));
  }
}

interface McpParsedResult {
  title: string;
  url: string;
  content: string;
}

function parseMcpText(text: string): McpParsedResult[] {
  const blocks = text.split(/(?=^Title: )/m).filter((b) => b.trim().length > 0);
  return blocks
    .map((block) => {
      const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
      const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
      const textStart = block.indexOf("\nHighlights:\n");
      const content = textStart >= 0 ? block.slice(textStart + 13).replace(/\n---\s*$/, "").trim() : "";
      return { title, url, content };
    })
    .filter((r) => r.url.length > 0);
}

/** callExaMcp 通过本机 mcporter CLI 以子进程方式调用 Exa 托管 MCP 的指定工具 */
export function callExaMcp(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "mcporter",
      ["call", "--http-url", EXA_MCP_URL, toolName, "--args", JSON.stringify(args), "--output", "json"],
      { timeout: MCP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(err.name === "AbortError" ? "Aborted" : `mcporter call failed: ${err.message}${stderr ? `\n${stderr.slice(0, 300)}` : ""}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
          const text = parsed.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;
          if (!text) {
            reject(new Error("Exa MCP returned an empty response"));
            return;
          }
          if (parsed.isError) {
            reject(new Error(text));
            return;
          }
          resolve(text);
        } catch (parseErr) {
          reject(new Error(`Failed to parse mcporter output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`));
        }
      },
    );
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

function buildMcpQuery(query: string, options: SearchOptions): string {
  const parts = [query];
  if (options.domainFilter?.length) {
    for (const d of options.domainFilter) parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
  }
  if (options.recencyFilter) {
    const now = new Date();
    const labels: Record<string, string> = {
      day: "past 24 hours",
      week: "past week",
      month: `${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`,
      year: String(now.getFullYear()),
    };
    parts.push(labels[options.recencyFilter]);
  }
  return parts.join(" ");
}

async function searchWithMcp(query: string, options: SearchOptions): Promise<SearchResponse> {
  let text: string;
  try {
    text = await callExaMcp("web_search_exa", {
      query: buildMcpQuery(query, options),
      numResults: options.numResults ?? 5,
      objective: "Return the most relevant, on-topic results for this query.",
    }, options.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("command not found") || message.includes("ENOENT")) {
      throw new Error(`Exa search unavailable: mcporter CLI is required for key-less Exa MCP search but was not found. Install mcporter, or set "exaApiKey" in web-search.json / EXA_API_KEY.`);
    }
    throw new Error(`Exa MCP search failed: ${message}`);
  }
  const results = parseMcpText(text);
  const answer = results.map((r) => `${r.content.replace(/\s+/g, " ").trim().slice(0, 500)}\nSource: ${r.title || r.url} (${r.url})`).join("\n\n");
  return {
    answer,
    results: results.map((r) => ({ title: r.title || r.url, url: r.url, snippet: "" })),
    ...(options.includeContent ? { inlineContent: results.filter((r) => r.content).map((r) => ({ url: r.url, title: r.title, content: r.content, error: null })) } : {}),
  };
}

async function search(query: string, options: SearchOptions): Promise<SearchResponse> {
  const apiKey = getApiKey();
  return apiKey ? searchWithApi(query, options, apiKey) : searchWithMcp(query, options);
}

export const exaProvider: SearchProvider = {
  id: "exa",
  label: "Exa",
  isAvailable() {
    // Exa 始终可用：有 Key 走 API，无 Key 走托管 MCP。
    return true;
  },
  search,
};

/** hasExaApiKey 供选源逻辑判断是否配置了独立 API Key（区分 MCP 兜底模式） */
export function hasExaApiKey(): boolean {
  const config = loadWebSearchConfig();
  return hasCredentialSource({ provider: "Exa", configuredValue: config.exaApiKey, environmentValue: process.env.EXA_API_KEY });
}
