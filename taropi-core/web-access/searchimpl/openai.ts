// OpenAI 搜索适配器：仅实现 Responses API 的托管 web_search 工具（不支持 alpha/search）。
// 认证优先级：Pi 的 openai-codex / openai 登录凭据 -> 独立 openaiApiKey/OPENAI_API_KEY。
// 支持自定义网关地址（openaiResponsesUrl）与模型（openaiSearchModel）。
import { loadWebSearchConfig, resolveApiBaseUrl } from "../config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "../credential.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import type { SearchProvider, SearchProviderContext } from "./types.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_SEARCH_PROVIDERS = ["openai-codex", "openai"] as const;
const DEFAULT_SEARCH_MODEL = "gpt-5.1";

interface OpenAIAuth {
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  responsesUrl: string;
  useCodexEndpoint: boolean;
}

function resolveResponsesUrl(config: ReturnType<typeof loadWebSearchConfig>): string {
  const value = config.openaiResponsesUrl;
  if (value === undefined) return OPENAI_RESPONSES_URL;
  if (typeof value !== "string" || !value.trim()) throw new Error("openaiResponsesUrl in web-search.json must be an absolute http(s) URL");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("openaiResponsesUrl in web-search.json must use http or https");
  return url.toString();
}

function resolveSearchModel(config: ReturnType<typeof loadWebSearchConfig>): string {
  const value = config.openaiSearchModel;
  if (value === undefined) return DEFAULT_SEARCH_MODEL;
  if (typeof value !== "string" || !value.trim()) throw new Error("openaiSearchModel in web-search.json must be a non-empty string");
  return value.trim();
}

function resolveSearchProviders(config: ReturnType<typeof loadWebSearchConfig>): readonly string[] {
  const value = config.openaiSearchProviders;
  if (value === undefined) return DEFAULT_SEARCH_PROVIDERS;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error("openaiSearchProviders in web-search.json must be an array of non-empty provider ids");
  }
  return value.map((v) => v.trim());
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isCodexJwt(token: string): boolean {
  return !!decodeJwtPayload(token)?.["https://api.openai.com/auth"];
}

function extractAccountId(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function resolvePiAuth(ctx: SearchProviderContext, config: ReturnType<typeof loadWebSearchConfig>): Promise<OpenAIAuth | undefined> {
  const providers = resolveSearchProviders(config);
  const model = resolveSearchModel(config);
  const responsesUrl = resolveResponsesUrl(config);
  let available: ReturnType<typeof ctx.modelRegistry.getAll>;
  try {
    available = ctx.modelRegistry.getAll();
  } catch {
    return undefined;
  }
  for (const providerId of providers) {
    const candidate = available.find((m) => m.provider === providerId);
    if (!candidate) continue;
    let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
    try {
      auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
    } catch {
      continue;
    }
    if (!auth.ok || !auth.apiKey) continue;
    const useCodexEndpoint = providerId === "openai-codex" || isCodexJwt(auth.apiKey);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
      if (value !== null) headers[name] = value;
    }
    return {
      apiKey: auth.apiKey,
      model,
      headers,
      responsesUrl: useCodexEndpoint ? CODEX_RESPONSES_URL : responsesUrl,
      useCodexEndpoint,
    };
  }
  return undefined;
}

async function resolveStandaloneAuth(config: ReturnType<typeof loadWebSearchConfig>): Promise<OpenAIAuth | undefined> {
  const hasSource = hasCredentialSource({ provider: "OpenAI", configuredValue: config.openaiApiKey, environmentValue: process.env.OPENAI_API_KEY });
  if (!hasSource) return undefined;
  const apiKey = resolveCredential({ provider: "OpenAI", configuredValue: config.openaiApiKey, environmentValue: process.env.OPENAI_API_KEY });
  if (!apiKey) return undefined;
  return { apiKey, model: resolveSearchModel(config), headers: {}, responsesUrl: resolveResponsesUrl(config), useCodexEndpoint: false };
}

async function resolveAuth(ctx?: SearchProviderContext): Promise<OpenAIAuth | undefined> {
  const config = loadWebSearchConfig();
  if (ctx) {
    const piAuth = await resolvePiAuth(ctx, config);
    if (piAuth) return piAuth;
  }
  return resolveStandaloneAuth(config);
}

function normalizeDomainFilter(domainFilter: string[] | undefined): { allowed_domains?: string[]; blocked_domains?: string[] } {
  if (!domainFilter?.length) return {};
  const allowed = domainFilter.filter((d) => !d.startsWith("-") && d.trim()).map((d) => d.trim());
  const blocked = domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()).filter(Boolean);
  return { ...(allowed.length ? { allowed_domains: allowed } : {}), ...(blocked.length ? { blocked_domains: blocked } : {}) };
}

function buildInstructions(options: SearchOptions): string {
  const lines = ["Search the web and return a concise answer grounded only in the web results.", "Include clickable source citations in the response text when possible."];
  if (options.recencyFilter) {
    const labels: Record<string, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
    lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
  }
  if (typeof options.numResults === "number" && Number.isFinite(options.numResults)) {
    lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
  }
  const filters = normalizeDomainFilter(options.domainFilter);
  if (filters.allowed_domains?.length) lines.push(`Only use sources from: ${filters.allowed_domains.join(", ")}.`);
  if (filters.blocked_domains?.length) lines.push(`Do not use sources from: ${filters.blocked_domains.join(", ")}.`);
  return lines.join(" ");
}

function isWebSearchCall(item: unknown): boolean {
  return !!item && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call";
}

async function parseOpenAIResponse(response: Response): Promise<{ output: unknown[]; webSearchCallSeen: boolean }> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    const output = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.output) ? parsed.output : [];
    return { output, webSearchCallSeen: output.some(isWebSearchCall) };
  }
  const outputItems: unknown[] = [];
  let webSearchCallSeen = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (typeof parsed.type === "string" && parsed.type.startsWith("response.web_search_call")) webSearchCallSeen = true;
      if (parsed.type === "response.output_item.done" && parsed.item) {
        outputItems.push(parsed.item);
        webSearchCallSeen ||= isWebSearchCall(parsed.item);
      }
    } catch {
      // 忽略无法解析的 SSE 行
    }
  }
  if (outputItems.length === 0) throw new Error("OpenAI API returned no parseable response output");
  return { output: outputItems, webSearchCallSeen };
}

function cleanSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function extractSearchResults(output: unknown[], numResults: number | undefined): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const addResult = (url: unknown, title: unknown) => {
    if (typeof url !== "string" || !url.trim()) return;
    const clean = cleanSourceUrl(url);
    if (seen.has(clean)) return;
    seen.add(clean);
    results.push({ title: typeof title === "string" && title.trim() ? title : clean, url: clean, snippet: "" });
  };
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const annotations = (part as { annotations?: unknown })?.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const a of annotations) {
        if ((a as { type?: unknown })?.type === "url_citation") addResult((a as { url?: unknown }).url, (a as { title?: unknown }).title);
      }
    }
  }
  return typeof numResults === "number" && numResults > 0 ? results.slice(0, Math.min(Math.floor(numResults), 20)) : results;
}

function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

async function search(query: string, options: SearchOptions, ctx?: SearchProviderContext): Promise<SearchResponse> {
  const auth = await resolveAuth(ctx);
  if (!auth) {
    throw new Error(
      "OpenAI web search unavailable. Either:\n" +
      "  1. Sign in with a Codex/OpenAI-authenticated Pi model\n" +
      '  2. Add "openaiApiKey" to web-search.json\n' +
      "  3. Set OPENAI_API_KEY environment variable",
    );
  }
  const body = {
    model: auth.model,
    instructions: buildInstructions(options),
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [{ type: "web_search", filters: normalizeDomainFilter(options.domainFilter) }],
    include: ["web_search_call.action.sources"],
    store: false,
    stream: true,
    tool_choice: "required" as const,
  };
  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
  };
  if (auth.useCodexEndpoint) {
    const accountId = extractAccountId(auth.apiKey);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    headers.originator = "pi";
  }

  try {
    const response = await fetch(auth.responsesUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errorText = redactCredential(await response.text(), auth.apiKey);
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
    }
    const parsed = await parseOpenAIResponse(response);
    if (!parsed.webSearchCallSeen) throw new Error("OpenAI web_search returned no web_search_call");
    const answer = extractAnswer(parsed.output);
    const results = extractSearchResults(parsed.output, options.numResults);
    if (!answer && results.length === 0) throw new Error("OpenAI web_search returned no answer or sources");
    return { answer, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactCredential(message, auth.apiKey));
  }
}

export const openaiProvider: SearchProvider = {
  id: "openai",
  label: "OpenAI",
  async isAvailable(ctx) {
    return (await resolveAuth(ctx)) !== undefined;
  },
  search,
};
