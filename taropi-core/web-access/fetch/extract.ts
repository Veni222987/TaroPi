// 网页/文本/图片/PDF/GitHub 内容抓取的主入口，供 fetch_content、source_check 复用。
import type TurndownService from "turndown";
import { readTextResponseWithLimit, readResponseBufferWithLimit, isTextContentType } from "./response-limits.ts";
import { extractGitHub, parseGitHubUrl } from "./github.ts";
import { extractPDFToMarkdown, isPDF } from "./pdf.ts";
import { assertAuthFetchUrl, fetchWithAuthProfile, type AuthFetchProfile } from "../auth/auth-fetch.ts";
import { loadWebSearchConfig, resolveDomainPolicy, resolveFetchTimeoutMs, resolveGithubCloneConfig, resolvePdfConfig, resolveSsrfConfig, isImageEnabled } from "../config.ts";
import { fetchRemoteUrl, validateRemoteUrl } from "../network/ssrf-protection.ts";
import { getProxyDispatcher, isHttpProxy } from "../network/proxy-fetch.ts";
import type { ExtractedContent, ExtractOptions } from "../types.ts";

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MIN_USEFUL_CONTENT = 500;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string): ExtractedContent {
  return { url, title: "", content: "", error: "Aborted" };
}

function extractHeadingTitle(text: string): string | null {
  const match = text.match(/^#{1,2}\s+(.+)/m);
  if (!match) return null;
  const cleaned = match[1].replace(/\*+/g, "").trim();
  return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
  return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

let turndownPromise: Promise<TurndownService> | undefined;
async function getTurndown() {
  turndownPromise ??= (async () => {
    const TurndownModule = await import("turndown");
    const Ctor = (TurndownModule as unknown as { default: new (options?: unknown) => TurndownService }).default;
    return new Ctor({ headingStyle: "atx", codeBlockStyle: "fenced" });
  })();
  return turndownPromise;
}

/** extractContent 按 URL 类型分派：GitHub 仓库、PDF、图片、纯文本或 HTML 正文提取 */
export async function extractContent(url: string, signal?: AbortSignal, options: ExtractOptions = {}): Promise<ExtractedContent> {
  if (signal?.aborted) return abortedResult(url);

  const config = loadWebSearchConfig();
  let remoteUrl: URL | null = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
  } catch (err) {
    return { url, title: "", content: "", error: errorMessage(err) };
  }

  const ssrf = resolveSsrfConfig(config);
  const domainPolicy = resolveDomainPolicy(config);
  if (remoteUrl) {
    try {
      await validateRemoteUrl(remoteUrl, { allowRanges: ssrf.allowRanges, trustEnvProxy: ssrf.trustEnvProxy, domainPolicy });
    } catch (err) {
      return { url, title: "", content: "", error: errorMessage(err) };
    }
  }

  if (options.mode === "raw" || options.auth) {
    return extractViaHttp(url, signal, options, config);
  }

  const githubInfo = remoteUrl && parseGitHubUrl(url);
  if (githubInfo) {
    const githubConfig = resolveGithubCloneConfig(config);
    if (githubConfig.enabled) {
      try {
        const result = await extractGitHub(url, signal, options.forceClone);
        if (result) return result;
        if (signal?.aborted) return abortedResult(url);
      } catch (err) {
        if (isAbortError(err)) return abortedResult(url);
      }
    }
  }

  return extractViaHttp(url, signal, options, config);
}

async function extractViaHttp(url: string, signal: AbortSignal | undefined, options: ExtractOptions, config: ReturnType<typeof loadWebSearchConfig>): Promise<ExtractedContent> {
  const timeoutMs = options.timeoutMs ?? resolveFetchTimeoutMs(config);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const ssrf = resolveSsrfConfig(config);
    const domainPolicy = resolveDomainPolicy(config);
    const requestInit: RequestInit = {
      signal: controller.signal,
      ...(options.proxy && isHttpProxy(options.proxy) ? { dispatcher: getProxyDispatcher(options.proxy) } as RequestInit : {}),
      headers: {
        "User-Agent": "TaroPi-web-access/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };

    const response = options.auth
      ? await fetchWithAuthProfileGuarded(url, requestInit, options.auth, { allowRanges: ssrf.allowRanges, trustEnvProxy: ssrf.trustEnvProxy, domainPolicy })
      : await fetchRemoteUrl(url, requestInit, { allowRanges: ssrf.allowRanges, trustEnvProxy: ssrf.trustEnvProxy, domainPolicy });

    if (!response.ok && options.mode !== "raw") {
      return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}`, status: response.status };
    }

    const contentType = response.headers.get("content-type") || "";
    const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const pdfConfig = resolvePdfConfig(config);
    const maxResponseSize = (isPDF(url, contentType) ? pdfConfig.maxSizeMB : 5) * 1024 * 1024;

    if (options.mode === "raw") {
      if (!isTextContentType(contentType)) return { url, title: "", content: "", error: `Unsupported content type in raw mode: ${mimeType || "missing"}`, mimeType, status: response.status };
      const text = await readTextResponseWithLimit(response, maxResponseSize);
      return { url, title: extractTextTitle(text, url), content: text, error: null, mimeType, status: response.status };
    }

    if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      if (!isImageEnabled(config)) return { url, title: "", content: "", error: "Image fetching is disabled by image.enabled", mimeType, status: response.status };
      const buffer = await readResponseBufferWithLimit(response, maxResponseSize);
      const { resizeImage } = await import("@earendil-works/pi-coding-agent");
      const resized = await resizeImage(new Uint8Array(buffer), mimeType, { maxWidth: 2000, maxHeight: 2000 });
      if (!resized) return { url, title: "", content: "", error: `Could not decode image: ${mimeType}`, mimeType, status: response.status };
      const title = new URL(response.url || url).pathname.split("/").pop() || url;
      return { url, title, content: `Image fetched (${resized.width}×${resized.height}, ${resized.mimeType})`, error: null, thumbnail: { data: resized.data, mimeType: resized.mimeType }, mimeType: resized.mimeType, status: response.status };
    }

    if (isPDF(url, contentType)) {
      if (!pdfConfig.enabled) return { url, title: "", content: "", error: "PDF extraction is disabled by pdf.enabled", mimeType, status: response.status };
      const buffer = await readResponseBufferWithLimit(response, maxResponseSize);
      if (signal?.aborted) return abortedResult(url);
      const result = await extractPDFToMarkdown(buffer, url, { maxPages: pdfConfig.maxPages });
      return { url, title: result.title, content: options.mode === "answer" ? result.content : `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`, error: null };
    }

    if (contentType.includes("application/octet-stream") || contentType.includes("audio/") || contentType.includes("video/") || contentType.includes("application/zip")) {
      return { url, title: "", content: "", error: `Unsupported content type: ${contentType.split(";")[0]}` };
    }

    const text = await readTextResponseWithLimit(response, maxResponseSize);
    const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    if (!isHTML) return { url, title: extractTextTitle(text, url), content: text, error: null };

    return await extractHtml(text, url, response.url || url);
  } catch (err) {
    return { url, title: "", content: "", error: errorMessage(err) };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) return abortedResult(url);
  }
}

async function fetchWithAuthProfileGuarded(url: string, init: RequestInit, profile: AuthFetchProfile, validation: Parameters<typeof fetchWithAuthProfile>[3]): Promise<Response> {
  assertAuthFetchUrl(profile, url);
  return fetchWithAuthProfile(url, init, profile, validation);
}

async function extractHtml(text: string, url: string, responseUrl: string): Promise<ExtractedContent> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(text);
  const documentTitle = document.title?.trim() ?? "";
  const { Readability } = await import("@mozilla/readability");
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article || typeof article.content !== "string") {
    return { url, title: documentTitle, content: "", error: "Could not extract readable content from HTML structure" };
  }
  const markdown = (await getTurndown()).turndown(article.content);
  if (markdown.length < MIN_USEFUL_CONTENT) {
    return { url, title: article.title || documentTitle, content: markdown, error: "Extracted content appears incomplete" };
  }
  return { url, title: article.title || documentTitle, content: markdown, error: null };
}
