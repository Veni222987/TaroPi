// Brave Search 适配器：REST API，支持数量、时间范围与域名过滤。
import { loadWebSearchConfig, resolveApiBaseUrl } from "../config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "../credential.ts";
import { apiFetch } from "../network/request.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import type { SearchProvider } from "./types.ts";

const BRAVE_API_BASE_URL = "https://api.search.brave.com/res/v1";
const SEARCH_TIMEOUT_MS = 30_000;
const RECENCY_MAP: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

function getApiKey(): string | null {
  const config = loadWebSearchConfig();
  return resolveCredential({ provider: "Brave", configuredValue: config.braveApiKey, environmentValue: process.env.BRAVE_API_KEY });
}

function getApiUrl(): string {
  const config = loadWebSearchConfig();
  return `${resolveApiBaseUrl({
    configKey: "braveBaseUrl",
    configuredValue: config.braveBaseUrl,
    defaultValue: BRAVE_API_BASE_URL,
    environmentKey: "BRAVE_BASE_URL",
    environmentValue: process.env.BRAVE_BASE_URL,
  })}/web/search`;
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("-")) input = input.slice(1).trim();
  if (!input) return null;
  try {
    input = (input.includes("://") ? new URL(input) : new URL(`https://${input}`)).hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function splitDomainFilters(domainFilter: string[] | undefined): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const raw of domainFilter ?? []) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    (raw.trim().startsWith("-") ? blocked : allowed).push(domain);
  }
  return { allowed, blocked };
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, filters: { allowed: string[]; blocked: string[] }): boolean {
  if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (filters.allowed.length > 0 && !filters.allowed.some((d) => hostMatchesDomain(hostname, d))) return false;
  return !filters.blocked.some((d) => hostMatchesDomain(hostname, d));
}

function buildQuery(query: string, filters: { allowed: string[]; blocked: string[] }): string {
  const parts = [query];
  if (filters.allowed.length === 1) parts.push(`site:${filters.allowed[0]}`);
  else if (filters.allowed.length > 1) parts.push(filters.allowed.map((d) => `site:${d}`).join(" OR "));
  for (const domain of filters.blocked) parts.push(`NOT site:${domain}`);
  return parts.join(" ");
}

function clampNumResults(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 20));
}

async function search(query: string, options: SearchOptions): Promise<SearchResponse> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "Brave Search API key not found. Either:\n" +
      '  1. Add "braveApiKey" to web-search.json\n' +
      "  2. Set BRAVE_API_KEY environment variable\n" +
      "Get a key at https://brave.com/search/api/",
    );
  }
  const numResults = clampNumResults(options.numResults);
  const filters = splitDomainFilters(options.domainFilter);
  const params = new URLSearchParams({ q: buildQuery(query, filters), count: String(options.domainFilter?.length ? 20 : numResults) });
  if (options.recencyFilter) {
    const freshness = RECENCY_MAP[options.recencyFilter];
    if (freshness) params.set("freshness", freshness);
  }

  try {
    const response = await apiFetch(`${getApiUrl()}?${params.toString()}`, {
      method: "GET",
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json", "Accept-Encoding": "gzip" },
    }, { timeoutMs: SEARCH_TIMEOUT_MS, signal: options.signal, credentialHeaders: ["X-Subscription-Token"] });

    if (!response.ok) {
      const errorText = redactCredential(await response.text(), apiKey);
      throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const results: SearchResult[] = [];
    for (const item of data.web?.results ?? []) {
      if (!item.url || !matchesDomainFilters(item.url, filters)) continue;
      results.push({ title: item.title || item.url, url: item.url, snippet: item.description || "" });
      if (results.length >= numResults) break;
    }
    const answer = results.map((r) => (r.snippet ? `${r.snippet}\nSource: ${r.title} (${r.url})` : `Source: ${r.title} (${r.url})`)).join("\n\n");
    return { answer, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactCredential(message, apiKey));
  }
}

export const braveProvider: SearchProvider = {
  id: "brave",
  label: "Brave",
  isAvailable() {
    const config = loadWebSearchConfig();
    return hasCredentialSource({ provider: "Brave", configuredValue: config.braveApiKey, environmentValue: process.env.BRAVE_API_KEY });
  },
  search,
};
