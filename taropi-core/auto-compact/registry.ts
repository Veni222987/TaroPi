// 离线自动压缩的会话注册表：记录每个会话的策略与下一次压缩时间。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nextCronTime } from "./cron.ts";
import { normalizeRule, unitToMs, type AutoCompactRule } from "./types.ts";

export const REGISTRY_VERSION = 1;

const ENTRY_SUFFIX = ".json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface RegistryRule extends AutoCompactRule {
  /** 下一次压缩时间（毫秒）；闲置策略未武装时为 null。 */
  nextAt: number | null;
}

export interface RegistryEntry {
  version: 1;
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  updatedAt: number;
  /** 最后一次会话活动时间，仅作诊断信息。 */
  lastActiveAt?: number;
  rules: RegistryRule[];
}

// getAgentConfigDirectory 返回 Pi 的用户配置目录，支持 PI_CODING_AGENT_DIR 覆盖。
export function getAgentConfigDirectory(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".pi", "agent");
}

// getRegistryDirectory 返回离线自动压缩注册表目录。
export function getRegistryDirectory(): string {
  return join(getAgentConfigDirectory(), "taropi", "auto-compact");
}

// getRegistrySessionsDirectory 返回按会话分文件存放的注册表目录。
export function getRegistrySessionsDirectory(): string {
  return join(getRegistryDirectory(), "sessions");
}

// getRegistryFilePath 返回单个会话的注册表文件路径。
export function getRegistryFilePath(sessionId: string): string {
  return join(getRegistrySessionsDirectory(), `${sessionId}${ENTRY_SUFFIX}`);
}

// advanceNextAt 计算压缩完成后的下一次触发时间；闲置策略在下次活动前保持未武装。
export function advanceNextAt(rule: AutoCompactRule, now = Date.now()): number | null {
  if (!rule.enabled) return null;
  if (rule.type === "cron") {
    if (!rule.cron) return null;
    return nextCronTime(rule.cron, new Date(now))?.getTime() ?? null;
  }
  if (rule.type === "every" && rule.value !== undefined && rule.unit) {
    const interval = unitToMs(rule.value, rule.unit);
    return interval === undefined ? null : now + interval;
  }
  return null;
}

// armRegistryRules 在会话活动后重新武装闲置策略，every / cron 保持原有计划。
export function armRegistryRules(previous: readonly RegistryRule[] | undefined, now = Date.now()): RegistryRule[] {
  if (!previous) return [];
  return previous.map((rule) => {
    if (!rule.enabled || rule.type !== "idle") return { ...rule };
    const interval = rule.value !== undefined && rule.unit ? unitToMs(rule.value, rule.unit) : undefined;
    return { ...rule, nextAt: interval === undefined ? null : now + interval };
  });
}

// nextDueAt 取所有启用规则中最早的到期时间，没有可调度规则时返回 undefined。
export function nextDueAt(entry: RegistryEntry): number | undefined {
  let earliest: number | undefined;
  for (const rule of entry.rules) {
    if (!rule.enabled || rule.nextAt === null) continue;
    if (earliest === undefined || rule.nextAt < earliest) earliest = rule.nextAt;
  }
  return earliest;
}

// hasEnabledRules 判断注册表条目里是否还有启用的策略。
export function hasEnabledRules(rules: readonly AutoCompactRule[]): boolean {
  return rules.some((rule) => rule.enabled);
}

// buildRegistryRules 按策略重建规则状态，用当前时间推进下一次压缩时间。
export function buildRegistryRules(rules: readonly AutoCompactRule[], now = Date.now()): RegistryRule[] {
  return rules.map((rule) => {
    const next: RegistryRule = { ...rule, nextAt: advanceNextAt(rule, now) };
    return next;
  });
}

// resumeRegistryRules 按策略恢复规则状态：未变更且尚未到期的规则保留原计划，其余按当前时间重算。
export function resumeRegistryRules(
  previous: readonly RegistryRule[] | undefined,
  rules: readonly AutoCompactRule[],
  now = Date.now(),
): RegistryRule[] {
  return rules.map((rule) => {
    const prior = previous?.find((item) => item.id === rule.id);
    const unchanged = prior !== undefined
      && prior.enabled === rule.enabled
      && prior.type === rule.type
      && prior.value === rule.value
      && prior.unit === rule.unit
      && prior.cron === rule.cron;
    const keep = unchanged && prior.nextAt !== null && prior.nextAt > now;
    return { ...rule, nextAt: keep ? prior.nextAt : advanceNextAt(rule, now) };
  });
}

// advanceRegistryRules 在压缩完成后整体推进所有启用规则的到期时间。
export function advanceRegistryRules(previous: readonly RegistryRule[], now = Date.now()): RegistryRule[] {
  return previous.map((rule) => ({ ...rule, nextAt: advanceNextAt(rule, now) }));
}

// readRegistryEntry 读取单个会话的注册表条目，文件缺失或损坏时返回 undefined。
export async function readRegistryEntry(sessionId: string): Promise<RegistryEntry | undefined> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
  try {
    return parseRegistryEntry(JSON.parse(await readFile(getRegistryFilePath(sessionId), "utf8")));
  } catch {
    return undefined;
  }
}

// writeRegistryEntry 原子写入单个会话的注册表条目。
export async function writeRegistryEntry(entry: RegistryEntry): Promise<void> {
  const file = getRegistryFilePath(entry.sessionId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

// removeRegistryEntry 删除单个会话的注册表条目，重复删除不报错。
export async function removeRegistryEntry(sessionId: string): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  await unlink(getRegistryFilePath(sessionId)).catch(() => undefined);
}

// listRegistryEntries 读取全部有效条目，损坏文件与同会话旧记录被跳过。
export async function listRegistryEntries(): Promise<RegistryEntry[]> {
  let names: string[];
  try {
    names = await readdir(getRegistrySessionsDirectory());
  } catch {
    return [];
  }
  const entries = new Map<string, RegistryEntry>();
  for (const name of names) {
    if (!name.endsWith(ENTRY_SUFFIX)) continue;
    const entry = await readRegistryEntry(name.slice(0, -ENTRY_SUFFIX.length));
    if (!entry) continue;
    const kept = entries.get(entry.sessionId);
    if (!kept || kept.updatedAt < entry.updatedAt) entries.set(entry.sessionId, entry);
  }
  return [...entries.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

// pruneRegistryEntries 删除失效的注册表条目，返回被删除的会话 id。
export async function pruneRegistryEntries(shouldKeep: (entry: RegistryEntry) => boolean): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await listRegistryEntries()) {
    if (shouldKeep(entry)) continue;
    await removeRegistryEntry(entry.sessionId);
    removed.push(entry.sessionId);
  }
  return removed;
}

function parseRegistryEntry(value: unknown): RegistryEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== REGISTRY_VERSION) return undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : Number.NaN;
  if (!SESSION_ID_PATTERN.test(sessionId) || !cwd || !Number.isFinite(updatedAt)) return undefined;
  if (!Array.isArray(raw.rules)) return undefined;
  const rules = raw.rules.flatMap((item): RegistryRule[] => {
    const normalized = normalizeRule(item);
    if (!normalized) return [];
    const nextAt = (item as { nextAt?: unknown }).nextAt;
    return [{ ...normalized, nextAt: typeof nextAt === "number" && Number.isFinite(nextAt) ? nextAt : null }];
  });
  const entry: RegistryEntry = { version: REGISTRY_VERSION, sessionId, cwd, updatedAt, rules };
  if (typeof raw.sessionFile === "string" && raw.sessionFile) entry.sessionFile = raw.sessionFile;
  if (typeof raw.lastActiveAt === "number" && Number.isFinite(raw.lastActiveAt)) entry.lastActiveAt = raw.lastActiveAt;
  return entry;
}
