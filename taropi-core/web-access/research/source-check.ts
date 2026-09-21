// source_check 证据整理：聚合搜索结果与抓取正文为结构化、去重的证据 artifact，供人工核验。
import { createHash } from "node:crypto";
import { generateId, getResult, storeResult } from "../content/storage.ts";
import type { ExtractedContent, SearchResult } from "../types.ts";

export type SourceQuality = "official_docs" | "vendor_docs" | "repo_issue" | "blog" | "forum" | "news" | "unknown";

export interface ResearchSource {
  rank: number;
  url: string;
  title: string;
  snippet?: string;
  quality: SourceQuality;
  fetched?: boolean;
  fetch_error?: string;
  content_hash?: string;
}

export interface ResearchPassage {
  passage_id: string;
  source_url: string;
  source_rank: number;
  text: string;
  content_hash: string;
}

export interface ResearchArtifact {
  id: string;
  type: "research";
  timestamp: number;
  query: string;
  sources: ResearchSource[];
  passages: ResearchPassage[];
  provider?: string;
  summary?: string;
  errors?: Array<{ query: string; error: string }>;
}

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/i;
const OFFICIAL_DOCS_PATHS = /\/(docs?|reference)(\/|\b)/i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com)/i;
const NEWS_HOSTS = /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com)/i;

/** classifySource 按主机名和路径粗略分类来源质量，仅用于展示，不代表证据可信度 */
export function classifySource(url: string): SourceQuality {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    return "unknown";
  }
  if (REPO_ISSUE_PATHS.test(path)) return "repo_issue";
  if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return "official_docs";
  if (NEWS_HOSTS.test(host)) return "news";
  if (FORUM_HOSTS.test(host)) return "forum";
  if (BLOG_HOSTS.test(host)) return "blog";
  return "unknown";
}

function hashContent(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function extractRelevantSpans(content: string, hint: string): string[] {
  const terms = [...new Set(hint.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3))];
  if (terms.length === 0) return [];
  const sentences = content.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [];
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 400)
    .map((sentence) => ({ sentence, score: terms.filter((t) => sentence.toLowerCase().includes(t)).length }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.sentence);
}

/** buildResearchArtifact 聚合搜索结果与已抓取正文，生成去重来源列表和证据片段 */
export function buildResearchArtifact(input: {
  query: string;
  provider?: string;
  summary?: string;
  results: SearchResult[];
  fetched?: ExtractedContent[];
  errors?: Array<{ query: string; error: string }>;
}): ResearchArtifact {
  const fetchedByUrl = new Map((input.fetched ?? []).map((page) => [page.url, page]));
  const sources: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const [index, result] of input.results.entries()) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const page = fetchedByUrl.get(result.url);
    sources.push({
      rank: index + 1,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      quality: classifySource(result.url),
      ...(page ? { fetched: !page.error } : {}),
      ...(page && !page.error ? { content_hash: hashContent(page.content) } : {}),
      ...(page?.error ? { fetch_error: page.error } : {}),
    });
  }

  const passages: ResearchPassage[] = [];
  for (const source of sources) {
    if (source.snippet) {
      passages.push({ passage_id: `p-${source.rank}-0`, source_url: source.url, source_rank: source.rank, text: source.snippet, content_hash: hashContent(source.snippet) });
    }
    const page = fetchedByUrl.get(source.url);
    if (page && !page.error && page.content) {
      extractRelevantSpans(page.content, source.snippet?.trim() || input.query).forEach((text, i) => {
        passages.push({ passage_id: `p-${source.rank}-${i + 1}`, source_url: source.url, source_rank: source.rank, text, content_hash: hashContent(text) });
      });
    }
  }

  return {
    id: generateId(),
    type: "research",
    timestamp: Date.now(),
    query: input.query,
    sources,
    passages,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.errors?.length ? { errors: input.errors } : {}),
  };
}

/** storeResearchArtifact 将 artifact 存入内存索引，供 get_search_content 按 responseId 检索 */
export function storeResearchArtifact(artifact: ResearchArtifact): void {
  storeResult(artifact.id, { id: artifact.id, type: "research", timestamp: artifact.timestamp, artifact });
}

/** getResearchArtifact 按 responseId 取回已存储的证据 artifact */
export function getResearchArtifact(id: string): ResearchArtifact | null {
  const data = getResult(id);
  if (!data || data.type !== "research" || !data.artifact) return null;
  return data.artifact as ResearchArtifact;
}
