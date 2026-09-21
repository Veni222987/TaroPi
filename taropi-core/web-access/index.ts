// web-access 模块入口：注册 web_search / fetch_content / get_search_content / source_check 四个工具。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./tools/fetch-content.ts";
import { createGetSearchContentTool } from "./tools/get-search-content.ts";
import { createSourceCheckTool } from "./tools/source-check.ts";
import { createWebSearchTool } from "./tools/web-search.ts";

/** registerWebAccess 注册网络访问四个工具：搜索源覆盖 Brave、Exa、OpenAI，抓取覆盖网页/GitHub/图片/本地 PDF */
export default function registerWebAccess(pi: ExtensionAPI): void {
  pi.registerTool(createWebSearchTool());
  pi.registerTool(createFetchContentTool());
  pi.registerTool(createGetSearchContentTool());
  pi.registerTool(createSourceCheckTool());
}
