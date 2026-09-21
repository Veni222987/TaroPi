// SSRF 防护：拒绝访问内网/私有地址，限制协议、校验重定向，支持域名 allow/deny 名单。
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import type { DomainPolicy } from "../config.ts";

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

export interface ValidationOptions {
  lookup?: Lookup;
  domainPolicy?: DomainPolicy;
  allowRanges?: string[];
  trustEnvProxy?: boolean;
}

interface ParsedCidr {
  bytes: Uint8Array;
  prefix: number;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function domainMatches(hostname: string, entry: string): boolean {
  return hostname === entry || hostname.endsWith(`.${entry}`);
}

function assertDomainPolicy(hostname: string, policy?: DomainPolicy): void {
  if (!policy) return;
  if (policy.deny.some((entry) => domainMatches(hostname, entry))) {
    throw new Error(`Blocked hostname by fetchContent domain policy: ${hostname}`);
  }
  if (policy.allow.length > 0 && !policy.allow.some((entry) => domainMatches(hostname, entry))) {
    throw new Error(`Hostname not allowed by fetchContent domain policy: ${hostname}`);
  }
}

function ipv4ToBytes(address: string): Uint8Array | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const octet = Number(parts[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

function parseIPv6(address: string): number[] | null {
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map((p) => Number(p));
    address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 && missing !== 0) return null;
  if (pieces.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
    return parseInt(part, 16);
  });
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function ipToBytes(address: string, version: number): Uint8Array | null {
  if (version === 4) return ipv4ToBytes(address);
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups ? ipv6GroupsToBytes(groups) : null;
  }
  return null;
}

function parseCidr(raw: string): ParsedCidr | null {
  if (!raw) return null;
  const slash = raw.lastIndexOf("/");
  const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
  if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
  const version = net.isIP(addrPart);
  if (version === 4) {
    const bytes = ipv4ToBytes(addrPart);
    if (!bytes) return null;
    const prefix = prefixPart === null ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
    return { bytes, prefix };
  }
  if (version === 6) {
    const groups = parseIPv6(addrPart);
    if (!groups) return null;
    const prefix = prefixPart === null ? 128 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
    return { bytes: ipv6GroupsToBytes(groups), prefix };
  }
  return null;
}

function parseAllowRanges(input: string[] | undefined): ParsedCidr[] {
  if (!input?.length) return [];
  return input.map((entry) => {
    const rule = parseCidr(entry.trim());
    if (!rule) throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
    return rule;
  });
}

function bytesMatchPrefix(addr: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const fullBytes = prefix >> 3;
  const remBits = prefix & 7;
  for (let i = 0; i < fullBytes; i++) if (addr[i] !== network[i]) return false;
  if (remBits > 0 && fullBytes < addr.length) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((addr[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
  }
  return true;
}

function isInAllowedRange(address: string, ipVersion: number, allowRanges: ParsedCidr[]): boolean {
  if (allowRanges.length === 0) return false;
  const addrBytes = ipToBytes(address, ipVersion);
  if (!addrBytes) return false;
  return allowRanges.some((rule) => rule.bytes.length === addrBytes.length && bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix));
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return true;
  const first = groups[0];
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  const isMappedIPv4 = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMappedIPv4) {
    const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    return isBlockedIPv4(ipv4);
  }
  return false;
}

function assertPublicAddress(address: string, hostname: string, allowRanges: ParsedCidr[]): void {
  const normalized = normalizeHostname(address);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
  if (isInAllowedRange(normalized, ipVersion, allowRanges)) return;
  if (ipVersion === 4 && isBlockedIPv4(normalized)) throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
  if (ipVersion === 6 && isBlockedIPv6(normalized)) throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
}

function getProxyForProtocol(protocol: string): string {
  const candidates = protocol === "http:"
    ? [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy]
    : protocol === "https:"
      ? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy]
      : [];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const proxyUrl = new URL(value);
      if ((proxyUrl.protocol === "http:" || proxyUrl.protocol === "https:") && proxyUrl.hostname) return value;
    } catch {
      // 忽略非法代理环境变量，不放宽本地 DNS 校验
    }
  }
  return "";
}

function hostnameMatchesNoProxy(hostname: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  const normalizedEntry = normalizeHostname(trimmed);
  if (!normalizedEntry) return false;
  if (normalizedEntry === hostname) return true;
  const suffix = normalizedEntry.startsWith(".") ? normalizedEntry : `.${normalizedEntry}`;
  return hostname.endsWith(suffix);
}

function shouldTrustEnvProxy(url: URL, enabled: boolean): boolean {
  if (!enabled || !getProxyForProtocol(url.protocol)) return false;
  const hostname = normalizeHostname(url.hostname);
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  return !noProxy.split(",").some((entry) => hostnameMatchesNoProxy(hostname, entry));
}

/** validateRemoteUrl 校验 URL 协议、内网地址与域名策略，返回归一化后的 URL */
export async function validateRemoteUrl(rawUrl: string | URL, options: ValidationOptions = {}): Promise<URL> {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error("URL must include a hostname");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  const allowRanges = parseAllowRanges(options.allowRanges);
  assertDomainPolicy(hostname, options.domainPolicy);

  if (net.isIP(hostname)) {
    assertPublicAddress(hostname, hostname, allowRanges);
    return url;
  }

  if (shouldTrustEnvProxy(url, options.trustEnvProxy === true)) return url;

  let addresses: LookupAddress[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to resolve ${hostname}: ${message}`);
  }
  if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  for (const { address } of addresses) assertPublicAddress(address, hostname, allowRanges);
  return url;
}

/** fetchRemoteUrl 在 SSRF 校验基础上安全地跟随重定向 */
export async function fetchRemoteUrl(
  url: string | URL,
  init: RequestInit = {},
  options: ValidationOptions & { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await validateRemoteUrl(url, options);
  let requestInit = init;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetch(current, { ...requestInit, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);
    const next = new URL(location, current);
    current = await validateRemoteUrl(next, options);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
      const { body: _body, ...nextInit } = requestInit;
      requestInit = { ...nextInit, method: "GET" };
    }
  }
  throw new Error(`Too many redirects fetching ${current.toString()}`);
}
