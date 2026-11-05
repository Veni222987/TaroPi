// 把会话策略同步到离线注册表，并维护心跳与 cron 任务。
import { ensureScannerCron, hasScannerCron, removeScannerCron, type CrontabResult } from "./crontab.ts";
import { SessionLiveness } from "./liveness.ts";
import {
  advanceRegistryRules,
  armRegistryRules,
  hasEnabledRules,
  listRegistryEntries,
  readRegistryEntry,
  removeRegistryEntry,
  resumeRegistryRules,
  writeRegistryEntry,
  type RegistryEntry,
} from "./registry.ts";
import type { AutoCompactRule } from "./types.ts";

export interface OfflineSyncHost {
  sessionManager: {
    getSessionId(): string;
    getCwd(): string;
    getSessionFile(): string | undefined;
  };
}

export interface OfflineSyncDeps {
  liveness?: SessionLiveness;
  ensureCron?: () => Promise<CrontabResult>;
  cronInstalled?: () => Promise<boolean>;
  removeCron?: () => Promise<CrontabResult>;
  warn?: (message: string) => void;
  now?: () => number;
}

export interface OfflineStatus {
  cronInstalled: boolean;
  entries: RegistryEntry[];
}

// OfflineCompactSync 负责注册表、心跳与 cron 的写入，写入串行执行避免互相覆盖。
export class OfflineCompactSync {
  private readonly liveness: SessionLiveness;
  private readonly ensureCron: () => Promise<CrontabResult>;
  private readonly cronInstalled: () => Promise<boolean>;
  private readonly removeCron: () => Promise<CrontabResult>;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private target: { sessionId: string; cwd: string; sessionFile?: string } | undefined;

  constructor(deps: OfflineSyncDeps = {}) {
    this.liveness = deps.liveness ?? new SessionLiveness();
    this.ensureCron = deps.ensureCron ?? (() => ensureScannerCron());
    this.cronInstalled = deps.cronInstalled ?? (() => hasScannerCron());
    this.removeCron = deps.removeCron ?? (() => removeScannerCron());
    this.warn = deps.warn ?? (() => undefined);
    this.now = deps.now ?? Date.now;
  }

  // start 在会话启动时开始心跳，并把当前生效的策略写入注册表。
  start(rules: readonly AutoCompactRule[], ctx: OfflineSyncHost): Promise<void> {
    const target = readTarget(ctx);
    this.target = target;
    if (!target) return Promise.resolve();
    this.liveness.start(target.sessionId);
    return this.syncRules(rules);
  }

  // save 在策略保存后重建条目；全部停用时删除条目。
  save(rules: readonly AutoCompactRule[], ctx: OfflineSyncHost): Promise<void> {
    this.target = readTarget(ctx);
    return this.syncRules(rules);
  }

  // recordActivity 在会话活动后重新武装闲置策略。
  recordActivity(ctx: OfflineSyncHost): Promise<void> {
    this.target = readTarget(ctx);
    return this.enqueue(async () => {
      const target = this.target;
      if (!target) return;
      const entry = await readRegistryEntry(target.sessionId);
      if (!entry || !hasEnabledRules(entry.rules)) return;
      const now = this.now();
      await writeRegistryEntry({ ...entry, updatedAt: now, lastActiveAt: now, rules: armRegistryRules(entry.rules, now) });
    });
  }

  // recordCompacted 在压缩完成后推进下一次压缩时间。
  recordCompacted(ctx: OfflineSyncHost): Promise<void> {
    this.target = readTarget(ctx);
    return this.enqueue(async () => {
      const target = this.target;
      if (!target) return;
      const entry = await readRegistryEntry(target.sessionId);
      if (!entry || !hasEnabledRules(entry.rules)) return;
      const now = this.now();
      await writeRegistryEntry({ ...entry, updatedAt: now, rules: advanceRegistryRules(entry.rules, now) });
      await this.ensureCronSafely();
    });
  }

  // stop 停止心跳；注册表保留给离线扫描。
  stop(): Promise<void> {
    this.liveness.stop();
    return this.enqueue(async () => undefined);
  }

  // status 返回 cron 安装状态与注册表中的会话列表。
  async status(): Promise<OfflineStatus> {
    await this.queue.catch(() => undefined);
    return { cronInstalled: await this.cronInstalled().catch(() => false), entries: await listRegistryEntries() };
  }

  // removeCronTask 手动移除扫描任务。
  async removeCronTask(): Promise<CrontabResult> {
    const result = await this.removeCron().catch((error: unknown) => ({
      status: "failed" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (result.status === "failed") this.warn(`移除离线压缩 cron 任务失败：${result.message ?? "未知错误"}`);
    return result;
  }

  private syncRules(rules: readonly AutoCompactRule[]): Promise<void> {
    return this.enqueue(async () => {
      const target = this.target;
      if (!target) return;
      if (!hasEnabledRules(rules)) {
        await removeRegistryEntry(target.sessionId);
        return;
      }
      const previous = await readRegistryEntry(target.sessionId);
      const now = this.now();
      const entry: RegistryEntry = {
        version: 1,
        sessionId: target.sessionId,
        cwd: target.cwd,
        updatedAt: now,
        lastActiveAt: now,
        rules: resumeRegistryRules(previous?.rules, rules, now),
      };
      if (target.sessionFile) entry.sessionFile = target.sessionFile;
      await writeRegistryEntry(entry);
      await this.ensureCronSafely();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue
      .catch(() => undefined)
      .then(() => task())
      .catch((error: unknown) => {
        this.warn(`离线压缩状态写入失败：${error instanceof Error ? error.message : String(error)}`);
      });
    this.queue = next;
    return next;
  }

  private async ensureCronSafely(): Promise<void> {
    const result = await this.ensureCron().catch((error: unknown) => ({
      status: "failed" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (result.status === "failed") this.warn(`安装离线压缩 cron 任务失败：${result.message ?? "未知错误"}`);
  }
}

function readTarget(ctx: OfflineSyncHost): { sessionId: string; cwd: string; sessionFile?: string } | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = ctx.sessionManager.getCwd();
  if (!sessionId || !cwd) return undefined;
  const sessionFile = ctx.sessionManager.getSessionFile();
  return sessionFile ? { sessionId, cwd, sessionFile } : { sessionId, cwd };
}
