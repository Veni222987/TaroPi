// fetch 层统一入口：并发抓取多个 URL，复用 extractContent 的分发逻辑。
import { extractContent } from "./extract.ts";
import type { ExtractedContent, ExtractOptions } from "../types.ts";

const CONCURRENT_LIMIT = 3;

async function withLimit<T>(items: string[], limit: number, run: (item: string) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await run(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** fetchAllContent 并发抓取多个 URL，最多同时 3 个请求 */
export async function fetchAllContent(urls: string[], signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent[]> {
  return withLimit(urls, CONCURRENT_LIMIT, (url) => extractContent(url, signal, options));
}

export { extractContent } from "./extract.ts";
export { isPDF } from "./pdf.ts";
export { parseGitHubUrl } from "./github.ts";
