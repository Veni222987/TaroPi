// 离线自动压缩：纯规则挑选到期的离线会话，并拉起一个 pi 会话执行压缩。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isProcessAlive, readActiveSessionIds } from "./liveness.ts";
import {
  advanceRegistryRules,
  getRegistryDirectory,
  listRegistryEntries,
  nextDueAt,
  pruneRegistryEntries,
  readRegistryEntry,
  removeRegistryEntry,
  writeRegistryEntry,
  type RegistryEntry,
} from "./registry.ts";

export const COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ScannerCandidate {
  sessionId: string;
  cwd: string;
  dueAt: number;
  /** 会话文件路径；拉起时优先用它，避免会话目录变化后按 id 找不到。 */
  sessionFile?: string;
}

export interface OfflineCompactResult {
  sessionId: string;
  status: "compacted" | "skipped" | "timeout" | "failed";
  message?: string;
}

export interface ScannerDeps {
  now?: number;
  activeSessionIds?: ReadonlySet<string>;
  spawnCompact?: (candidate: ScannerCandidate) => Promise<OfflineCompactResult>;
  log?: (message: string) => void;
}

// planDueEntries 纯规则挑出到期且没有活动进程的会话，按到期时间升序。
export function planDueEntries(
  entries: readonly RegistryEntry[],
  now: number,
  activeSessionIds: ReadonlySet<string>,
): ScannerCandidate[] {
  const candidates: ScannerCandidate[] = [];
  for (const entry of entries) {
    if (activeSessionIds.has(entry.sessionId)) continue;
    const dueAt = nextDueAt(entry);
    if (dueAt === undefined || dueAt > now) continue;
    const candidate: ScannerCandidate = { sessionId: entry.sessionId, cwd: entry.cwd, dueAt };
    if (entry.sessionFile) candidate.sessionFile = entry.sessionFile;
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.dueAt - right.dueAt || left.sessionId.localeCompare(right.sessionId));
}

// resolvePiBinary 返回拉起会话使用的 pi 可执行文件路径。
export function resolvePiBinary(): string | undefined {
  const override = process.env.TAROPI_PI_BIN?.trim();
  if (override) return override;
  const local = join(homedir(), ".pi", "agent", "bin", "pi");
  if (existsSync(local)) return local;
  return undefined;
}

// compactSessionOffline 在会话目录下拉起一个 RPC 会话，发送 compact 命令并等待结果。
export async function compactSessionOffline(
  candidate: ScannerCandidate,
  options: { piBinary?: string; timeoutMs?: number; sessionFile?: string } = {},
): Promise<OfflineCompactResult> {
  const binary = options.piBinary ?? resolvePiBinary() ?? "pi";
  const sessionTarget = options.sessionFile ?? candidate.sessionFile ?? candidate.sessionId;
  const timeoutMs = options.timeoutMs ?? COMPACT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(binary, ["--session", sessionTarget, "--mode", "rpc"], {
      cwd: candidate.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    const stderrChunks: string[] = [];
    const finish = (result: OfflineCompactResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ sessionId: candidate.sessionId, status: "timeout", message: `超过 ${timeoutMs}ms 未完成` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        const record = parseRecord(line);
        if (!record || record.type !== "response" || record.command !== "compact") continue;
        if (record.success) finish({ sessionId: candidate.sessionId, status: "compacted" });
        else finish({ sessionId: candidate.sessionId, status: "failed", message: stringField(record, "error") });
        return;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrChunks.length < 20) stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      finish({ sessionId: candidate.sessionId, status: "failed", message: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      const message = stderrChunks.join("").trim() || `pi 退出码 ${code}`;
      finish({ sessionId: candidate.sessionId, status: "failed", message });
    });
    // 保持 stdin 打开直到拿到结果：Pi 以关闭 stdin 作为有序退出信号，提前关闭会中断压缩。
    child.stdin.write(`${JSON.stringify({ type: "compact" })}\n`);
  });
}

// runScannerOnce 执行一轮扫描：清理失效条目、挑出到期会话、逐个拉起压缩。
export async function runScannerOnce(deps: ScannerDeps = {}): Promise<OfflineCompactResult[]> {
  const now = deps.now ?? Date.now();
  const log = deps.log ?? (() => undefined);
  await pruneRegistryEntries((entry) => keepEntry(entry));
  const entries = await listRegistryEntries();
  const active = deps.activeSessionIds ?? await readActiveSessionIds();
  const candidates = planDueEntries(entries, now, active);
  if (candidates.length === 0) {
    log(`[${new Date(now).toISOString()}] 没有到期的离线会话`);
    return [];
  }
  const spawnCompact = deps.spawnCompact ?? ((candidate) => compactSessionOffline(candidate));
  const results: OfflineCompactResult[] = [];
  for (const candidate of candidates) {
    const result = await spawnCompact(candidate);
    results.push(result);
    log(`[${new Date().toISOString()}] ${candidate.sessionId} ${result.status}${result.message ? `: ${result.message}` : ""}`);
    // 无论成败都推进到下一周期：拉起会话可能未加载扩展，扫描器必须自己避免重复拉起。
    await advanceEntry(candidate.sessionId, Date.now());
  }
  return results;
}

// keepEntry 判断注册表条目是否仍然值得保留。
function keepEntry(entry: RegistryEntry): boolean {
  if (entry.rules.every((rule) => !rule.enabled)) return false;
  if (!entry.sessionFile) return true;
  return existsSync(entry.sessionFile);
}

// advanceEntry 把启用规则推进到下一周期，避免同一会话每分钟重复拉起。
async function advanceEntry(sessionId: string, now: number): Promise<void> {
  const entry = await readRegistryEntry(sessionId);
  if (!entry) return;
  const rules = advanceRegistryRules(entry.rules, now);
  if (rules.every((rule) => rule.nextAt === null)) {
    await removeRegistryEntry(sessionId);
    return;
  }
  await writeRegistryEntry({ ...entry, rules, updatedAt: now });
}

interface ScannerLock {
  version: 1;
  pid: number;
  updatedAt: number;
}

// getScannerLockPath 返回扫描器锁文件路径。
export function getScannerLockPath(): string {
  return join(getRegistryDirectory(), "scanner.lock");
}

// acquireScannerLock 抢扫描锁，已有存活进程持锁时返回 undefined。
export async function acquireScannerLock(now = Date.now()): Promise<(() => Promise<void>) | undefined> {
  const file = getScannerLockPath();
  const existing = await readLock(file);
  if (existing && isProcessAlive(existing.pid)) return undefined;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, updatedAt: now } satisfies ScannerLock), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  return async () => {
    const current = await readLock(file);
    if (current?.pid !== process.pid) return;
    await unlink(file).catch(() => undefined);
  };
}

async function readLock(file: string): Promise<ScannerLock | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<ScannerLock>;
    if (value.version !== 1) return undefined;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
    if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
    return { version: 1, pid: value.pid, updatedAt: value.updatedAt };
  } catch {
    return undefined;
  }
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

// isEntryPoint 判断当前模块是否作为脚本直接执行。
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

// runScannerMain 作为 cron 入口执行一轮扫描，结束后退出。
async function runScannerMain(): Promise<void> {
  const release = await acquireScannerLock();
  if (!release) {
    console.log(`[${new Date().toISOString()}] 已有扫描进程在运行，跳过本轮`);
    return;
  }
  try {
    await runScannerOnce({ log: (message) => console.log(message) });
  } finally {
    await release();
  }
}

if (isEntryPoint()) {
  runScannerMain().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
