import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type AgentSessionStatus = "idle" | "working";

export interface AgentSessionPresence {
  version: 1;
  instanceId: string;
  pid: number;
  sessionId: string;
  cwd: string;
  status: AgentSessionStatus;
  updatedAt: number;
}

export interface AgentSessionPresenceOptions {
  directory?: string;
  heartbeatMs?: number;
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  onChange?: () => void;
}

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_POLL_MS = 1_000;
const PRESENCE_FILE_SUFFIX = ".json";

// getAgentPresenceDirectory 返回当前用户的 HUD 运行时状态目录。
export function getAgentPresenceDirectory(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory) return join(runtimeDirectory, "taropi-hud");
  const userId = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `taropi-hud-${userId}`);
}

// groupAgentDirectories 按完整目录分别去重并稳定排序 agent 会话目录。
export function groupAgentDirectories(records: readonly AgentSessionPresence[]): Record<AgentSessionStatus, string[]> {
  const idle = new Set<string>();
  const working = new Set<string>();
  for (const record of records) {
    if (record.status === "idle") idle.add(record.cwd);
    else working.add(record.cwd);
  }
  return {
    idle: [...idle].sort((left, right) => left.localeCompare(right)),
    working: [...working].sort((left, right) => left.localeCompare(right)),
  };
}

// AgentSessionPresenceStore 在本机已加载 HUD 的交互会话之间同步状态。
export class AgentSessionPresenceStore {
  private readonly directory: string;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly onChange?: () => void;
  private readonly instanceId = randomUUID();
  private current: AgentSessionPresence | undefined;
  private remoteRecords: AgentSessionPresence[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private snapshot = "";
  private active = false;

  constructor(options: AgentSessionPresenceOptions = {}) {
    this.directory = options.directory ?? getAgentPresenceDirectory();
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.onChange = options.onChange;
  }

  // start 注册当前交互会话并启动心跳与其他会话状态监听。
  start(sessionId: string, cwd: string, status: AgentSessionStatus): void {
    this.stopTimers();
    this.active = true;
    this.current = {
      version: 1,
      instanceId: this.instanceId,
      pid: process.pid,
      sessionId,
      cwd,
      status,
      updatedAt: this.now(),
    };
    this.queueWrite();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
    this.heartbeatTimer.unref?.();
    this.pollTimer.unref?.();
    void this.refresh();
  }

  // setStatus 更新当前会话状态，并立即同步给其他 HUD 会话。
  setStatus(status: AgentSessionStatus): void {
    if (!this.current || !this.active) return;
    if (this.current.status === status) return;
    this.current = { ...this.current, status, updatedAt: this.now() };
    this.queueWrite();
    this.notifyIfChanged();
  }

  // getRecords 返回包含当前会话的有效会话快照。
  getRecords(): AgentSessionPresence[] {
    if (!this.current || !this.active) return this.remoteRecords;
    return [...this.remoteRecords.filter((record) => record.instanceId !== this.instanceId), this.current];
  }

  // refresh 读取其他已加载 HUD 的交互会话，并清理失效记录。
  async refresh(): Promise<void> {
    if (!this.active) return;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      this.remoteRecords = [];
      this.notifyIfChanged();
      return;
    }

    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(PRESENCE_FILE_SUFFIX))
        .map(async (name) => {
          const file = join(this.directory, name);
          const record = await readPresenceFile(file);
          if (!record || !this.isRecordActive(record)) {
            void unlink(file).catch(() => undefined);
            return undefined;
          }
          return record;
        }),
    );
    this.remoteRecords = records.filter((record): record is AgentSessionPresence => record !== undefined);
    this.notifyIfChanged();
  }

  // stop 删除当前会话记录，并释放后台定时器。
  async stop(): Promise<void> {
    this.active = false;
    this.stopTimers();
    await this.writeQueue;
    const record = this.current;
    this.current = undefined;
    this.remoteRecords = [];
    this.snapshot = "";
    if (!record) return;
    await unlink(this.getFilePath(record.instanceId)).catch(() => undefined);
  }

  private heartbeat(): void {
    if (!this.current || !this.active) return;
    this.current = { ...this.current, updatedAt: this.now() };
    this.queueWrite();
  }

  private queueWrite(): void {
    const record = this.current;
    if (!record || !this.active) return;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.active) return;
        const current = this.current;
        if (!current) return;
        const file = this.getFilePath(current.instanceId);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(current), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
      });
  }

  private isRecordActive(record: AgentSessionPresence): boolean {
    return this.now() - record.updatedAt <= this.staleMs && this.isProcessAlive(record.pid);
  }

  private getFilePath(instanceId: string): string {
    return join(this.directory, `${instanceId}${PRESENCE_FILE_SUFFIX}`);
  }

  private notifyIfChanged(): void {
    const nextSnapshot = this.getRecords()
      .map((record) => `${record.instanceId}\u0000${record.status}\u0000${record.cwd}`)
      .sort()
      .join("\u0001");
    if (nextSnapshot === this.snapshot) return;
    this.snapshot = nextSnapshot;
    this.onChange?.();
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = undefined;
    this.pollTimer = undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isPermissionError(error);
  }
}

function isPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}

async function readPresenceFile(file: string): Promise<AgentSessionPresence | undefined> {
  try {
    return parsePresence(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

function parsePresence(value: unknown): AgentSessionPresence | undefined {
  if (!isRecord(value)) return undefined;
  const version = value.version;
  const instanceId = value.instanceId;
  const pid = value.pid;
  const sessionId = value.sessionId;
  const cwd = value.cwd;
  const status = value.status;
  const updatedAt = value.updatedAt;
  if (version !== 1 || typeof instanceId !== "string" || typeof sessionId !== "string" || typeof cwd !== "string") return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
  if (status !== "idle" && status !== "working") return undefined;
  return { version, instanceId, pid, sessionId, cwd, status, updatedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
