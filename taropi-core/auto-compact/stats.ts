import { basename } from "node:path";
import { nextDueAt, type RegistryEntry } from "./registry.ts";
import { formatRulesStatus, type AutoCompactRule } from "./types.ts";


export interface CompactionStats {
  count: number;
  lastAt?: number;
}

interface CompactionEntryLike {
  type?: string;
  timestamp?: string;
}

// readCompactionStats 统计当前分支的压缩次数，并保留最后一条有效时间。
export function readCompactionStats(entries: readonly CompactionEntryLike[]): CompactionStats {
  let count = 0;
  let lastAt: number | undefined;
  for (const entry of entries) {
    if (entry?.type !== "compaction") continue;
    count += 1;
    const parsed = Date.parse(entry.timestamp ?? "");
    if (Number.isFinite(parsed)) lastAt = parsed;
  }
  return lastAt === undefined ? { count } : { count, lastAt };
}

// formatCompactionTime 把压缩时间格式化为当天时分，或其他日期的月日时分。
export function formatCompactionTime(time: number, now = Date.now()): string {
  const date = new Date(time);
  const current = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === current.getFullYear()
    && date.getMonth() === current.getMonth()
    && date.getDate() === current.getDate();
  if (sameDay) return clock;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

// formatAutoCompactHud 生成自动压缩版块文本；没有启用策略且没有压缩记录时返回空字符串。
export function formatAutoCompactHud(rules: readonly AutoCompactRule[], stats: CompactionStats, now = Date.now()): string {
  const enabled = rules.filter((rule) => rule.enabled);
  if (enabled.length === 0 && stats.count <= 0) return "";
  const parts: string[] = [];
  if (stats.lastAt !== undefined) parts.push(`上次 ${formatCompactionTime(stats.lastAt, now)}`);
  parts.push(`压缩 ${stats.count} 次`);
  parts.push(enabled.length === 0 ? "无策略" : formatRulesStatus(enabled));
  return parts.join(" · ");
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export interface OfflineStatusView {
  cronInstalled: boolean;
  entries: readonly RegistryEntry[];
}

// formatOfflineStatus 生成 /auto-compact-cron 的状态文本，只列未到期的会话。
export function formatOfflineStatus(status: OfflineStatusView, now = Date.now()): string {
  const cron = status.cronInstalled ? "已安装" : "未安装";
  const pending = status.entries.filter((entry) => {
    const due = nextDueAt(entry);
    return due !== undefined && due > now;
  });
  if (pending.length === 0) return `离线压缩扫描任务${cron}；没有待压缩会话`;
  const lines = pending.map((entry) => `${formatSessionLabel(entry)} · 下次 ${formatCompactionTime(nextDueAt(entry) as number, now)}`);
  return [`离线压缩扫描任务${cron}；共 ${pending.length} 个会话`, ...lines].join("\n");
}

const SESSION_LABEL_LIMIT = 20;

// formatSessionLabel 取会话名并截断到 20 字，没有名字时回退到目录名。
export function formatSessionLabel(entry: RegistryEntry): string {
  const source = entry.name?.trim() || basename(entry.cwd) || entry.sessionId.slice(0, 8);
  const chars = [...source];
  return chars.length <= SESSION_LABEL_LIMIT ? source : `${chars.slice(0, SESSION_LABEL_LIMIT - 1).join("")}…`;
}
