// authFetch：显式配置主机白名单后，用本机浏览器 Cookie 发起登录态抓取；默认关闭，仅同源重定向。
import { loadWebSearchConfig, resolveAuthFetchProfiles, isBrowserCookieAccessAllowed, resolveBrowserCookieSelection } from "../config.ts";
import { validateRemoteUrl, type ValidationOptions } from "../network/ssrf-protection.ts";
import { getBrowserCookieHeaderForHosts, getLastCookieDiagnostic } from "./chrome-cookies.ts";

export interface AuthFetchProfile {
  name: string;
  hosts: string[];
  chromeProfile?: string;
  browser?: string;
  cache: "session" | "off";
}

/** resolveAuthFetchProfile 按名称（或唯一 profile 时的 true）解析登录态抓取配置 */
export function resolveAuthFetchProfile(request: true | string): AuthFetchProfile {
  const config = loadWebSearchConfig();
  const profiles = [...resolveAuthFetchProfiles(config).entries()];
  if (profiles.length === 0) throw new Error("auth requires at least one authFetch profile in web-search.json");
  if (request === true) {
    if (profiles.length !== 1) throw new Error("auth: true requires exactly one authFetch profile; use a profile name instead");
    const [name, value] = profiles[0];
    return { name, ...value };
  }
  const found = profiles.find(([name]) => name === request.trim());
  if (!found) throw new Error(`Unknown authFetch profile: ${request}`);
  return { name: found[0], ...found[1] };
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function hostMatches(hostname: string, allowedHost: string): boolean {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}

/** assertAuthFetchUrl 校验目标 URL 必须是 HTTPS，且主机在 profile 白名单内 */
export function assertAuthFetchUrl(profile: AuthFetchProfile, rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Authenticated fetch requires an HTTPS URL");
  const hostname = normalizeHostname(url.hostname);
  if (!profile.hosts.some((host) => hostMatches(hostname, host))) {
    throw new Error(`URL host ${hostname} is not allowed by authFetch profile ${profile.name}`);
  }
  return url;
}

/** authFetchRedirectGuard 禁止授权抓取过程中的跨源重定向，避免登录态泄露到未授权站点 */
export function authFetchRedirectGuard(profile: AuthFetchProfile, from: URL, to: URL): void {
  if (to.origin !== from.origin) {
    throw new Error(`Authenticated fetch refused cross-origin redirect: ${from.origin} -> ${to.origin}`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** fetchWithAuthProfile 使用授权 profile 对应的浏览器 Cookie 发起登录态抓取，遵守 SSRF 与同源重定向限制 */
export async function fetchWithAuthProfile(url: string, init: RequestInit, profile: AuthFetchProfile, validation: ValidationOptions = {}): Promise<Response> {
  const config = loadWebSearchConfig();
  if (!isBrowserCookieAccessAllowed(config)) {
    throw new Error(`Browser cookie access is disabled; set "allowBrowserCookies": true in web-search.json to use authFetch profile ${profile.name}`);
  }
  let current = assertAuthFetchUrl(profile, url);
  await validateRemoteUrl(current, validation);
  let requestInit = init;
  const defaultSelection = resolveBrowserCookieSelection(config);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const cookieHeader = await getBrowserCookieHeaderForHosts({
      hosts: [current.hostname],
      browser: profile.browser ?? defaultSelection.browser,
      profile: profile.chromeProfile ?? defaultSelection.profile,
    });
    if (!cookieHeader) {
      const diagnostic = getLastCookieDiagnostic();
      throw new Error(`Authenticated fetch profile ${profile.name} could not read browser cookies${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    const headers = { ...(requestInit.headers as Record<string, string>), cookie: cookieHeader };
    const response = await fetch(current, { ...requestInit, headers, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === 5) throw new Error(`Too many redirects fetching ${current.toString()}`);
    const from = current;
    const next = new URL(location, current);
    await validateRemoteUrl(next, validation);
    authFetchRedirectGuard(profile, from, next);
    current = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
      const { body: _body, ...nextInit } = requestInit;
      requestInit = { ...nextInit, method: "GET" };
    }
  }
  throw new Error(`Too many redirects fetching ${current.toString()}`);
}
