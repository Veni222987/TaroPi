// 代理转发：调用方传入的 http(s)/socks 代理 URL 转换为 undici ProxyAgent dispatcher。
import { ProxyAgent } from "undici";

const PROXY_SCHEMES = new Set(["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

/** normalizeProxyUrl 校验代理 URL 格式；空字符串代表强制直连 */
export function normalizeProxyUrl(value: string | undefined, source: string): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${source} must be a valid proxy URL: ${JSON.stringify(trimmed)}`);
  }
  if (!PROXY_SCHEMES.has(parsed.protocol)) {
    throw new Error(`${source} must use the http://, https://, or socks scheme: ${trimmed}`);
  }
  if (!parsed.hostname) throw new Error(`${source} must include a proxy host: ${trimmed}`);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

const dispatcherCache = new Map<string, ProxyAgent>();

/** getProxyDispatcher 为给定代理 URL 返回可复用的 undici dispatcher（http/https 代理） */
export function getProxyDispatcher(proxyUrl: string): ProxyAgent {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;
  const agent = new ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, agent);
  return agent;
}

/** isHttpProxy 判断代理是否为 undici ProxyAgent 支持的 http(s) 代理（socks 暂不支持，会显式报错） */
export function isHttpProxy(proxyUrl: string): boolean {
  const protocol = new URL(proxyUrl).protocol;
  return protocol === "http:" || protocol === "https:";
}
