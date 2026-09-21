// web-access 配置加载：读取 ~/.pi/(agent/)web-search.json，只解析本模块支持的字段。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedConfigDir: string | undefined;

/** getWebSearchConfigDir 解析 web-search.json 所在目录，兼容旧版 ~/.pi 与新版 ~/.pi/agent */
export function getWebSearchConfigDir(): string {
  if (cachedConfigDir) return cachedConfigDir;
  const explicit = process.env.PI_CODING_AGENT_DIR;
  if (explicit) return (cachedConfigDir = explicit);

  const agentDir = join(homedir(), ".pi", "agent");
  if (existsSync(join(agentDir, "web-search.json"))) return (cachedConfigDir = agentDir);

  const legacyDir = join(homedir(), ".pi");
  if (existsSync(join(legacyDir, "web-search.json"))) return (cachedConfigDir = legacyDir);

  return (cachedConfigDir = agentDir);
}

/** getWebSearchConfigPath 返回 web-search.json 的完整路径 */
export function getWebSearchConfigPath(): string {
  return join(getWebSearchConfigDir(), "web-search.json");
}

export type FetchMode = "readable" | "raw" | "answer";

export interface DomainPolicy {
  allow: string[];
  deny: string[];
}

export interface AuthFetchProfileConfig {
  hosts: string[];
  chromeProfile?: string;
  browser?: string;
  cache: "session" | "off";
}

export interface BrowserCookieSelection {
  browser?: string;
  profile?: string;
}

export interface WebSearchConfig {
  provider?: unknown;
  workflow?: unknown;
  proxy?: unknown;
  maxInlineContentChars?: unknown;

  braveApiKey?: unknown;
  braveBaseUrl?: unknown;
  exaApiKey?: unknown;
  exaBaseUrl?: unknown;
  openaiApiKey?: unknown;
  openaiResponsesUrl?: unknown;
  openaiSearchModel?: unknown;
  openaiUseProviderBaseUrl?: unknown;
  openaiSearchProviders?: unknown;

  fetch?: {
    defaultMode?: unknown;
    allowedModes?: unknown;
    timeout?: unknown;
    answerProvider?: unknown;
    answerModel?: unknown;
  };
  fetchContent?: {
    domainPolicy?: { allow?: unknown; deny?: unknown };
  };
  ssrf?: {
    allowRanges?: unknown;
    trustEnvProxy?: unknown;
  };
  githubClone?: {
    enabled?: unknown;
    maxRepoSizeMB?: unknown;
    cloneTimeoutSeconds?: unknown;
    clonePath?: unknown;
  };
  pdf?: {
    enabled?: unknown;
    maxSizeMB?: unknown;
    maxPages?: unknown;
  };
  image?: {
    enabled?: unknown;
  };
  authFetch?: Record<string, unknown>;
  allowBrowserCookies?: unknown;
  browserCookies?: { browser?: unknown; profile?: unknown };
  summaryModel?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;
let cachedConfigPath: string | null = null;

function parseRoot(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** loadWebSearchConfig 读取并缓存 web-search.json；文件不存在时返回空对象 */
export function loadWebSearchConfig(): WebSearchConfig {
  const path = getWebSearchConfigPath();
  if (cachedConfig && cachedConfigPath === path) return cachedConfig;
  if (!existsSync(path)) {
    cachedConfig = {};
    cachedConfigPath = path;
    return cachedConfig;
  }
  const raw = readFileSync(path, "utf-8");
  cachedConfig = parseRoot(raw, path) as WebSearchConfig;
  cachedConfigPath = path;
  return cachedConfig;
}

/** clearWebSearchConfigCache 供测试重置缓存 */
export function clearWebSearchConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
  cachedConfigDir = undefined;
}

/** resolveApiBaseUrl 校验并规范化自定义 API 基础地址（必须是不含凭据/查询参数的 HTTPS URL） */
export function resolveApiBaseUrl(options: {
  configKey: string;
  configuredValue: unknown;
  defaultValue: string;
  environmentKey: string;
  environmentValue: string | undefined;
}): string {
  const fromEnv = options.environmentValue !== undefined;
  const value = fromEnv ? options.environmentValue : options.configuredValue;
  if (value === undefined) return options.defaultValue;

  const source = fromEnv ? options.environmentKey : `${options.configKey} in ${getWebSearchConfigPath()}`;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${source} must be an absolute HTTP(S) URL`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${source} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${source} must be an absolute HTTPS URL`);
  if (url.username || url.password) throw new Error(`${source} must not include credentials`);
  if (url.search || url.hash) throw new Error(`${source} must not include query parameters or fragments`);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

const FETCH_MODES: FetchMode[] = ["readable", "raw", "answer"];

/** resolveFetchModeConfig 解析 fetch.defaultMode / fetch.allowedModes，非法配置直接报错 */
export function resolveFetchModeConfig(config: WebSearchConfig): { defaultMode: FetchMode; allowedModes: FetchMode[] } {
  const configuredModes = config.fetch?.allowedModes ?? FETCH_MODES;
  if (!Array.isArray(configuredModes) || configuredModes.length === 0 || configuredModes.some((m) => !FETCH_MODES.includes(m as FetchMode))) {
    throw new Error(`fetch.allowedModes in ${getWebSearchConfigPath()} must be a non-empty array containing only "readable", "raw", or "answer"`);
  }
  const allowedModes = [...new Set(configuredModes as FetchMode[])];
  const defaultMode = (config.fetch?.defaultMode as FetchMode) ?? "readable";
  if (!allowedModes.includes(defaultMode)) {
    throw new Error(`fetch.defaultMode in ${getWebSearchConfigPath()} must be one of fetch.allowedModes`);
  }
  return { defaultMode, allowedModes };
}

/** resolveFetchTimeoutMs 解析 fetch.timeout（秒），默认 30 秒 */
export function resolveFetchTimeoutMs(config: WebSearchConfig): number {
  const value = config.fetch?.timeout;
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`fetch.timeout in ${getWebSearchConfigPath()} must be a positive number of seconds`);
  }
  return Math.max(1, Math.ceil(value * 1000));
}

/** resolveDomainPolicy 解析 fetchContent.domainPolicy 的 allow/deny 主机名列表 */
export function resolveDomainPolicy(config: WebSearchConfig): DomainPolicy {
  const policy = config.fetchContent?.domainPolicy;
  if (!policy) return { allow: [], deny: [] };
  return {
    allow: parseHostnameList(policy.allow, "fetchContent.domainPolicy.allow"),
    deny: parseHostnameList(policy.deny, "fetchContent.domainPolicy.deny"),
  };
}

function parseHostnameList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} in ${getWebSearchConfigPath()} must be an array of hostnames`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label} in ${getWebSearchConfigPath()} must contain only non-empty hostnames`);
    }
    return entry.trim().toLowerCase();
  });
}

/** resolveSsrfConfig 解析 ssrf.allowRanges / ssrf.trustEnvProxy */
export function resolveSsrfConfig(config: WebSearchConfig): { allowRanges: string[]; trustEnvProxy: boolean } {
  const ssrf = config.ssrf;
  if (!ssrf) return { allowRanges: [], trustEnvProxy: false };
  const allowRanges = ssrf.allowRanges;
  if (allowRanges !== undefined && (!Array.isArray(allowRanges) || allowRanges.some((r) => typeof r !== "string"))) {
    throw new Error(`ssrf.allowRanges in ${getWebSearchConfigPath()} must be an array of CIDR strings`);
  }
  if (ssrf.trustEnvProxy !== undefined && typeof ssrf.trustEnvProxy !== "boolean") {
    throw new Error(`ssrf.trustEnvProxy in ${getWebSearchConfigPath()} must be a boolean`);
  }
  return {
    allowRanges: (allowRanges as string[] | undefined) ?? [],
    trustEnvProxy: ssrf.trustEnvProxy === true,
  };
}

/** resolveGithubCloneConfig 解析 githubClone 相关限制 */
export function resolveGithubCloneConfig(config: WebSearchConfig): { enabled: boolean; maxRepoSizeMB: number; cloneTimeoutSeconds: number; clonePath: string } {
  const gc = config.githubClone ?? {};
  return {
    enabled: typeof gc.enabled === "boolean" ? gc.enabled : true,
    maxRepoSizeMB: typeof gc.maxRepoSizeMB === "number" && gc.maxRepoSizeMB > 0 ? gc.maxRepoSizeMB : 350,
    cloneTimeoutSeconds: typeof gc.cloneTimeoutSeconds === "number" && gc.cloneTimeoutSeconds > 0 ? gc.cloneTimeoutSeconds : 30,
    clonePath: typeof gc.clonePath === "string" && gc.clonePath.trim() ? expandPath(gc.clonePath.trim()) : "/tmp/pi-taropi-github-repos",
  };
}

function expandPath(value: string): string {
  let expanded = value;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = expanded.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
  }
  return expanded.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (match, name) => process.env[name] ?? match);
}

/** resolvePdfConfig 解析 pdf.enabled / pdf.maxSizeMB / pdf.maxPages */
export function resolvePdfConfig(config: WebSearchConfig): { enabled: boolean; maxSizeMB: number; maxPages: number } {
  const pdf = config.pdf ?? {};
  return {
    enabled: pdf.enabled !== false,
    maxSizeMB: typeof pdf.maxSizeMB === "number" && pdf.maxSizeMB > 0 ? Math.min(pdf.maxSizeMB, 50) : 20,
    maxPages: typeof pdf.maxPages === "number" && pdf.maxPages > 0 ? Math.floor(pdf.maxPages) : 100,
  };
}

/** isImageEnabled 解析 image.enabled，默认开启 */
export function isImageEnabled(config: WebSearchConfig): boolean {
  return config.image?.enabled !== false;
}

/** resolveMaxInlineContentChars 解析结果内联字符上限 */
export function resolveMaxInlineContentChars(config: WebSearchConfig): number {
  const value = config.maxInlineContentChars;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return 30_000;
  return Math.min(value, 200_000);
}

const AUTH_PROFILE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** resolveAuthFetchProfiles 解析 authFetch 中声明的所有登录态抓取 profile */
export function resolveAuthFetchProfiles(config: WebSearchConfig): Map<string, AuthFetchProfileConfig> {
  const profiles = new Map<string, AuthFetchProfileConfig>();
  if (!config.authFetch) return profiles;
  for (const [name, value] of Object.entries(config.authFetch)) {
    if (!AUTH_PROFILE_NAME_PATTERN.test(name)) {
      throw new Error(`authFetch profile name ${JSON.stringify(name)} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
    }
    profiles.set(name, parseAuthFetchProfile(name, value));
  }
  return profiles;
}

function parseAuthFetchProfile(name: string, value: unknown): AuthFetchProfileConfig {
  const path = getWebSearchConfigPath();
  if (Array.isArray(value)) {
    return { hosts: parseHosts(value, `authFetch.${name}`, path), cache: "session" };
  }
  if (!value || typeof value !== "object") {
    throw new Error(`authFetch.${name} in ${path} must be an array of hosts or an object`);
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.hosts)) throw new Error(`authFetch.${name}.hosts in ${path} must be a non-empty array of hostnames`);
  const cache = raw.cache ?? "session";
  if (cache !== "session" && cache !== "off") throw new Error(`authFetch.${name}.cache in ${path} must be "session" or "off"`);
  const chromeProfile = typeof raw.chromeProfile === "string" ? raw.chromeProfile.trim() : undefined;
  if (chromeProfile && (chromeProfile === "." || chromeProfile === ".." || chromeProfile.includes("/") || chromeProfile.includes("\\"))) {
    throw new Error(`authFetch.${name}.chromeProfile in ${path} must be a profile directory name, not a path`);
  }
  const browser = typeof raw.browser === "string" ? raw.browser.trim().toLowerCase() : undefined;
  return {
    hosts: parseHosts(raw.hosts, `authFetch.${name}.hosts`, path),
    ...(chromeProfile ? { chromeProfile } : {}),
    ...(browser ? { browser } : {}),
    cache,
  };
}

function parseHosts(value: unknown[], label: string, path: string): string[] {
  if (value.length === 0) throw new Error(`${label} in ${path} must be a non-empty array of hostnames`);
  const hosts = value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} in ${path} must contain only hostnames`);
    const host = entry.trim().toLowerCase();
    if (!host || /\s|[\\/?:#@*]/.test(host)) throw new Error(`${label} in ${path} contains an invalid hostname: ${JSON.stringify(entry)}`);
    return host;
  });
  return [...new Set(hosts)];
}

/** isBrowserCookieAccessAllowed 判断是否显式授权读取本机浏览器 Cookie */
export function isBrowserCookieAccessAllowed(config: WebSearchConfig): boolean {
  if (process.env.PI_ALLOW_BROWSER_COOKIES === "1") return true;
  return config.allowBrowserCookies === true;
}

/** resolveBrowserCookieSelection 解析默认使用的浏览器/profile（可被 profile 级配置覆盖） */
export function resolveBrowserCookieSelection(config: WebSearchConfig): BrowserCookieSelection {
  const raw = config.browserCookies;
  if (!raw) return {};
  const browser = typeof raw.browser === "string" ? raw.browser.trim().toLowerCase() : undefined;
  const profile = typeof raw.profile === "string" ? raw.profile.trim() : undefined;
  return { ...(browser ? { browser } : {}), ...(profile ? { profile } : {}) };
}
