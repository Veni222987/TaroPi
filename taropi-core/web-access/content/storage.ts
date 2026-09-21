// 结果存储：内存索引 + 磁盘缓存（fetch 类型正文），支持按 responseId 检索、分页与过期清理。
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWebSearchConfigDir } from "../config.ts";
import type { ExtractedContent, SearchResult } from "../types.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_DIR_NAME = "web-access-cache";
const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]+\.json$/;
const CACHE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_LIMITS = { maxEntries: 128, maxBytes: 128 * 1024 * 1024 };

export interface QueryResultData {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
  provider?: string;
}

export interface StoredSearchData {
  id: string;
  type: "search" | "fetch" | "research";
  timestamp: number;
  queries?: QueryResultData[];
  urls?: ExtractedContent[];
  artifact?: unknown;
}

const storedResults = new Map<string, StoredSearchData>();

/** generateId 生成用于 responseId 的唯一短标识 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getCacheDir(): string {
  return join(getWebSearchConfigDir(), CACHE_DIR_NAME);
}

function cacheKeyForId(id: string): string {
  if (!CACHE_ID_PATTERN.test(id)) throw new Error(`Invalid stored content id: ${id}`);
  return `${id}.json`;
}

function safeCacheDir(): string {
  const dir = getCacheDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, data] of storedResults) {
    if (data.type === "fetch" && now - data.timestamp >= CACHE_TTL_MS) storedResults.delete(id);
  }
  let dir: string;
  try {
    dir = safeCacheDir();
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!CACHE_KEY_PATTERN.test(entry)) continue;
    const path = join(dir, entry);
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (now - info.mtimeMs >= CACHE_TTL_MS) {
        unlinkSync(path);
        continue;
      }
      files.push({ name: entry, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 忽略并发删除等竞态错误
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let index = 0;
  while ((files.length - index > DEFAULT_LIMITS.maxEntries || totalBytes > DEFAULT_LIMITS.maxBytes) && index < files.length) {
    const file = files[index];
    try {
      unlinkSync(join(dir, file.name));
      totalBytes -= file.size;
    } catch {
      // 忽略
    }
    index++;
  }
}

function writeCacheFile(id: string, data: StoredSearchData): void {
  const dir = safeCacheDir();
  const key = cacheKeyForId(id);
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > DEFAULT_LIMITS.maxBytes) {
    throw new Error(`Stored content exceeds ${DEFAULT_LIMITS.maxBytes} bytes`);
  }
  const finalPath = join(dir, key);
  const tmpPath = join(dir, `${key}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, serialized, "utf8");
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 忽略
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // 忽略
    }
    throw err;
  }
  pruneExpired();
}

function readCacheFile(id: string): StoredSearchData | null {
  const dir = getCacheDir();
  const key = cacheKeyForId(id);
  const path = join(dir, key);
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isValidStoredData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidStoredData(data: unknown): data is StoredSearchData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return false;
  if (d.type !== "search" && d.type !== "fetch" && d.type !== "research") return false;
  if (typeof d.timestamp !== "number") return false;
  return true;
}

/** storeResult 存储搜索/研究结果（常驻内存，不落盘） */
export function storeResult(id: string, data: StoredSearchData): void {
  storedResults.set(id, data);
}

/** storeFetchResult 存储 fetch_content 正文：内存索引 + 磁盘缓存，缓存写入失败会抛错 */
export function storeFetchResult(id: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }): void {
  pruneExpired();
  writeCacheFile(id, data);
  storedResults.set(id, data);
}

/** getResult 按 responseId 检索：先查内存，fetch 类型缺失时回退读取磁盘缓存 */
export function getResult(id: string): StoredSearchData | null {
  const cached = storedResults.get(id);
  if (cached) {
    if (cached.type === "fetch" && Date.now() - cached.timestamp >= CACHE_TTL_MS) {
      storedResults.delete(id);
      return null;
    }
    return cached;
  }
  const fromDisk = readCacheFile(id);
  if (fromDisk && Date.now() - fromDisk.timestamp < CACHE_TTL_MS) {
    storedResults.set(id, fromDisk);
    return fromDisk;
  }
  return null;
}

/** clearResults 清空内存索引，供测试和会话切换时重置 */
export function clearResults(): void {
  storedResults.clear();
}
