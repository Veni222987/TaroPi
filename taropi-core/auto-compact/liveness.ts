// 全模式会话心跳：让离线扫描器判断某个会话当前是否有进程在跑。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const LIVENESS_VERSION = 1;

export const DEFAULT_LIVENESS_HEARTBEAT_MS = 5_000;
export const DEFAULT_LIVENESS_STALE_MS = 15_000;

const FILE_SUFFIX = ".json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface LivenessRecord {
  version: 1;
  sessionId: string;
  pid: number;
  updatedAt: number;
}

export interface LivenessOptions {
  directory?: string;
  heartbeatMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

// getLivenessDirectory 返回心跳文件目录，优先 XDG_RUNTIME_DIR，否则退到临时目录。
export function getLivenessDirectory(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDirectory) return join(runtimeDirectory, "taropi-liveness");
  const userId = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `taropi-liveness-${userId}`);
}

// isProcessAlive 判断 pid 对应的进程是否仍然存在，权限错误视为存活。
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

// SessionLiveness 维护当前进程的心跳文件，供离线扫描器判定会话活跃状态。
export class SessionLiveness {
  private readonly directory: string;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private current: LivenessRecord | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: LivenessOptions = {}) {
    this.directory = options.directory ?? getLivenessDirectory();
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_LIVENESS_HEARTBEAT_MS;
    this.now = options.now ?? Date.now;
    this.isAlive = options.isProcessAlive ?? isProcessAlive;
  }

  // start 开始为指定会话写心跳，重复调用会切换目标会话。
  start(sessionId: string): void {
    this.stop();
    if (!SESSION_ID_PATTERN.test(sessionId)) return;
    this.current = { version: LIVENESS_VERSION, sessionId, pid: process.pid, updatedAt: this.now() };
    this.queueWrite();
    this.timer = setInterval(() => {
      if (!this.current) return;
      this.current = { ...this.current, updatedAt: this.now() };
      this.queueWrite();
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  // stop 停止心跳并删除本进程写的心跳文件。
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const record = this.current;
    this.current = undefined;
    if (!record) return;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => unlink(this.getFilePath(record.sessionId)).catch(() => undefined));
  }

  private queueWrite(): void {
    const record = this.current;
    if (!record) return;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const file = this.getFilePath(record.sessionId);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        if (!this.current) await unlink(file).catch(() => undefined);
      });
  }

  private getFilePath(sessionId: string): string {
    return join(this.directory, `${sessionId}${FILE_SUFFIX}`);
  }
}

// readLivenessRecords 读取全部心跳文件，损坏的文件被跳过。
export async function readLivenessRecords(directory = getLivenessDirectory()): Promise<LivenessRecord[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const records: LivenessRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(FILE_SUFFIX)) continue;
    const record = await readLivenessFile(join(directory, name));
    if (record) records.push(record);
  }
  return records;
}

// readActiveSessionIds 返回当前仍在运行的会话 id 集合。
export async function readActiveSessionIds(options: LivenessOptions & { staleMs?: number } = {}): Promise<Set<string>> {
  const now = (options.now ?? Date.now)();
  const staleMs = options.staleMs ?? DEFAULT_LIVENESS_STALE_MS;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const active = new Set<string>();
  for (const record of await readLivenessRecords(options.directory)) {
    if (now - record.updatedAt > staleMs) continue;
    if (!isAlive(record.pid)) continue;
    active.add(record.sessionId);
  }
  return active;
}

async function readLivenessFile(file: string): Promise<LivenessRecord | undefined> {
  try {
    return parseLivenessRecord(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

function parseLivenessRecord(value: unknown): LivenessRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== LIVENESS_VERSION) return undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  const pid = typeof raw.pid === "number" ? raw.pid : Number.NaN;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : Number.NaN;
  if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (!Number.isFinite(updatedAt)) return undefined;
  return { version: LIVENESS_VERSION, sessionId, pid, updatedAt };
}
