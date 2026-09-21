// 统一请求封装：SSRF 校验 + 可选代理 + 超时 + 跨源重定向剥离认证头。
import { getProxyDispatcher, isHttpProxy } from "./proxy-fetch.ts";
import { validateRemoteUrl, type ValidationOptions } from "./ssrf-protection.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_BODY_HEADERS = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"];

export interface ApiRequestOptions {
  proxy?: string;
  credentialHeaders?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

function combinedSignal(timeoutMs: number | undefined, signal: AbortSignal | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** apiFetch 面向第三方 API 的请求封装：不做 SSRF 校验（目标是可信 API 域名），支持代理、超时与凭据重定向剥离 */
export async function apiFetch(url: string, init: RequestInit, options: ApiRequestOptions = {}): Promise<Response> {
  let current = new URL(url);
  let requestInit: RequestInit = {
    ...init,
    signal: combinedSignal(options.timeoutMs, options.signal),
    ...(options.proxy && isHttpProxy(options.proxy) ? { dispatcher: getProxyDispatcher(options.proxy) } as RequestInit : {}),
  };

  for (let redirects = 0; ; redirects++) {
    const response = await fetch(current, { ...requestInit, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === 5) throw new Error(`Too many API redirects from ${url}`);

    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`API redirect from ${current.origin} must use HTTP(S)`);
    }
    const method = requestInit.method?.toUpperCase() ?? "GET";
    if (((response.status === 301 || response.status === 302) && method === "POST") || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
      const headers = new Headers(requestInit.headers);
      for (const name of CREDENTIAL_BODY_HEADERS) headers.delete(name);
      const { body: _body, ...withoutBody } = requestInit;
      requestInit = { ...withoutBody, method: "GET", headers };
    }
    if (next.origin !== current.origin) {
      const headers = new Headers(requestInit.headers);
      for (const name of options.credentialHeaders ?? []) headers.delete(name);
      requestInit = { ...requestInit, headers };
    }
    current = next;
  }
}

/** ssrfSafeFetch 面向用户提供 URL 的抓取：先做 SSRF 校验，再按需走代理，支持超时 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit,
  options: ApiRequestOptions & ValidationOptions = {},
): Promise<Response> {
  const validated = await validateRemoteUrl(url, options);
  const requestInit: RequestInit = {
    ...init,
    signal: combinedSignal(options.timeoutMs, options.signal),
    ...(options.proxy && isHttpProxy(options.proxy) ? { dispatcher: getProxyDispatcher(options.proxy) } as RequestInit : {}),
  };
  let current = validated;
  let currentInit = requestInit;
  const maxRedirects = options.maxRedirects ?? 5;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetch(current, { ...currentInit, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);
    const next = new URL(location, current);
    current = await validateRemoteUrl(next, options);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentInit.method?.toUpperCase() === "POST")) {
      const { body: _body, ...withoutBody } = currentInit;
      currentInit = { ...withoutBody, method: "GET" };
    }
  }
  throw new Error(`Too many redirects fetching ${current.toString()}`);
}
