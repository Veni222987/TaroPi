// 搜索结果摘要：仅在 workflow=auto-summary 时调用模型，默认使用当前 Pi 模型，可用 summaryModel 覆盖。
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadWebSearchConfig } from "../config.ts";
import type { QueryResultData } from "../content/storage.ts";

export interface SummaryMeta {
  model: string | null;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

function summarizeQueryResult(result: QueryResultData): string {
  if (result.error) return `Query: ${result.query}\nStatus: Error\nError: ${result.error}`;
  const lines = [`Query: ${result.query}`, `Provider: ${result.provider ?? "unknown"}`, `Answer: ${result.answer || "(no answer text returned)"}`];
  if (result.results.length === 0) {
    lines.push("Sources: none");
    return lines.join("\n");
  }
  lines.push("Sources:");
  result.results.forEach((source, i) => lines.push(`${i + 1}. ${source.title} — ${source.url}`));
  return lines.join("\n");
}

function buildSummaryPrompt(results: QueryResultData[]): string {
  const sections = [
    "You are writing the final web search summary for a coding assistant.",
    "Write a concise, factual summary using only the provided search results.",
    "- Keep it readable and skimmable.",
    "- Include key findings and caveats.",
    "- Do not invent sources or claims.",
    "- If evidence is weak or conflicting, say so explicitly.",
    "- End with a short \"Sources\" section listing the most relevant URLs.",
    "",
    "<search_results>",
  ];
  results.forEach((result, i) => sections.push(`\n[Result ${i + 1}]`, summarizeQueryResult(result)));
  sections.push("\n</search_results>");
  return sections.join("\n");
}

function buildDeterministicSummary(results: QueryResultData[]): string {
  if (results.length === 0) return "No completed search results were available.\n\nSources\n- None";
  const lines: string[] = ["Summary based on the currently selected search results.", ""];
  const sourceUrls: string[] = [];
  for (const result of results) {
    if (result.error) {
      lines.push(`- ${result.query}: failed (${result.error})`);
      continue;
    }
    const preview = result.answer.replace(/\s+/g, " ").trim().slice(0, 240);
    lines.push(`- ${result.query}: ${preview || `returned ${result.results.length} source(s) without answer text.`}`);
    for (const source of result.results) if (!sourceUrls.includes(source.url)) sourceUrls.push(source.url);
  }
  lines.push("", "Sources");
  if (sourceUrls.length === 0) lines.push("- None");
  else sourceUrls.slice(0, 12).forEach((url) => lines.push(`- ${url}`));
  return lines.join("\n");
}

function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = (part as Record<string, unknown>).text;
    return typeof value === "string" ? value : "";
  }).filter((t) => t.trim().length > 0).join("\n").trim();
}

function resolveConfiguredModel(config: ReturnType<typeof loadWebSearchConfig>): { provider: string; id: string } | undefined {
  const value = config.summaryModel;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("summaryModel in web-search.json must be a non-empty string");
  const separator = value.indexOf("/");
  if (separator <= 0) throw new Error(`Invalid summaryModel: ${value}. Use provider/model-id.`);
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

/** generateSearchSummary 基于搜索结果生成摘要：优先使用当前 Pi 模型，失败时降级为确定性摘要 */
export async function generateSearchSummary(results: QueryResultData[], ctx: ExtensionContext, signal?: AbortSignal): Promise<{ summary: string; meta: SummaryMeta }> {
  let model: ExtensionContext["model"];
  try {
    const config = loadWebSearchConfig();
    const configured = resolveConfiguredModel(config);
    model = configured ? ctx.modelRegistry.find(configured.provider, configured.id) : ctx.model;
  } catch (err) {
    return { summary: buildDeterministicSummary(results), meta: { model: null, fallbackUsed: true, fallbackReason: err instanceof Error ? err.message : String(err) } };
  }
  if (!model) {
    return { summary: buildDeterministicSummary(results), meta: { model: null, fallbackUsed: true, fallbackReason: "No summary model available" } };
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) throw new Error(`No API key available for summary model ${model.provider}/${model.id}`);
    const { complete } = await import("@earendil-works/pi-ai/compat");
    const response = await complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: buildSummaryPrompt(results) }], timestamp: Date.now() }],
    }, { apiKey: auth.apiKey, headers: auth.headers, signal, maxTokens: 2000 });
    if (response.stopReason === "aborted") throw new Error("Aborted");
    const summary = responseText(response.content);
    if (!summary) throw new Error("Summary model returned an empty response");
    return { summary, meta: { model: `${model.provider}/${model.id}`, fallbackUsed: false } };
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { summary: buildDeterministicSummary(results), meta: { model: null, fallbackUsed: true, fallbackReason: message } };
  }
}
