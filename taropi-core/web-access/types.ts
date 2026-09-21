// web-access 模块的公共类型：搜索、抓取、存储三类数据结构共用。

/** 单条搜索结果 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 搜索选项，所有 provider 共用 */
export interface SearchOptions {
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  includeContent?: boolean;
  signal?: AbortSignal;
}

/** provider 返回的搜索响应 */
export interface SearchResponse {
  answer: string;
  results: SearchResult[];
  inlineContent?: ExtractedContent[];
}

/** 归属到具体 provider 的搜索响应 */
export interface AttributedSearchResponse extends SearchResponse {
  provider: SearchProviderId;
}

/** 支持的搜索来源 */
export const SEARCH_PROVIDER_IDS = ["brave", "exa", "openai"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export type SearchProviderSelection = "auto" | SearchProviderId | SearchProviderId[];

/** URL/文件抓取结果 */
export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  thumbnail?: { data: string; mimeType: string };
  mimeType?: string;
  status?: number;
}

/** 抓取模式：readable=正文提取，raw=原始文本，answer=基于正文问答 */
export type FetchMode = "readable" | "raw" | "answer";

export interface ExtractOptions {
  timeoutMs?: number;
  forceClone?: boolean;
  mode?: FetchMode;
  proxy?: string;
  auth?: AuthFetchProfile;
  signal?: AbortSignal;
}

/** authFetch 授权抓取的具体 profile */
export interface AuthFetchProfile {
  name: string;
  hosts: string[];
  chromeProfile?: string;
  browser?: string;
  cache: "session" | "off";
}
