// 自动压缩策略的数据结构、校验与展示文本。

export const AUTO_COMPACT_ENTRY = "taropi:auto-compact";

export type AutoCompactType = "every" | "idle" | "cron";
export type TimeUnit = "s" | "m" | "h";

export interface AutoCompactRule {
  id: string;
  enabled: boolean;
  type: AutoCompactType;
  /** every / idle 的数值；cron 不使用。 */
  value?: number;
  /** every / idle 的单位。 */
  unit?: TimeUnit;
  /** 标准 5 段 cron 表达式。 */
  cron?: string;
}

export interface AutoCompactEntryData {
  rules: AutoCompactRule[];
}

const UNITS: TimeUnit[] = ["s", "m", "h"];
const TYPES: AutoCompactType[] = ["every", "idle", "cron"];

const UNIT_MS: Record<TimeUnit, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

// unitToMs 把正整数数值换成毫秒；非法组合返回 undefined。
export function unitToMs(value: number, unit: TimeUnit): number | undefined {
  if (!Number.isInteger(value) || value <= 0) return undefined;
  const factor = UNIT_MS[unit];
  if (!factor) return undefined;
  return value * factor;
}

// isAutoCompactType 判断策略类型。
export function isAutoCompactType(value: unknown): value is AutoCompactType {
  return typeof value === "string" && TYPES.includes(value as AutoCompactType);
}

// isTimeUnit 判断时间单位。
export function isTimeUnit(value: unknown): value is TimeUnit {
  return typeof value === "string" && UNITS.includes(value as TimeUnit);
}

// formatRule 生成单条策略的单行说明。
export function formatRule(rule: AutoCompactRule): string {
  if (rule.type === "cron") return `cron ${(rule.cron ?? "").trim()}`;
  const amount = rule.value ?? "?";
  const unit = rule.unit ?? "?";
  return rule.type === "every" ? `每隔 ${amount}${unit}` : `闲置 ${amount}${unit}`;
}

// formatRulesStatus 生成命令与 HUD 使用的策略概览。
export function formatRulesStatus(rules: readonly AutoCompactRule[]): string {
  const enabled = rules.filter((rule) => rule.enabled);
  if (enabled.length === 0) return rules.length === 0 ? "当前会话没有自动压缩策略" : "自动压缩策略均已停用";
  return enabled.map(formatRule).join(" · ");
}

let idSequence = 0;

// createRuleId 生成会话内唯一的策略 id。
export function createRuleId(now = Date.now()): string {
  idSequence += 1;
  return `ac-${now.toString(36)}-${idSequence}`;
}

// normalizeRule 丢掉无法调度的记录，保留可编辑字段。
export function normalizeRule(value: unknown): AutoCompactRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<AutoCompactRule>;
  if (typeof raw.id !== "string" || !raw.id.trim() || !isAutoCompactType(raw.type) || typeof raw.enabled !== "boolean") return undefined;
  const rule: AutoCompactRule = { id: raw.id, enabled: raw.enabled, type: raw.type };
  if (raw.type === "cron") {
    if (typeof raw.cron !== "string" || !raw.cron.trim()) return undefined;
    rule.cron = raw.cron.trim();
    return rule;
  }
  if (typeof raw.value !== "number" || !isTimeUnit(raw.unit) || unitToMs(raw.value, raw.unit) === undefined) return undefined;
  rule.value = raw.value;
  rule.unit = raw.unit;
  return rule;
}

// readAutoCompactRules 取分支上最新一条自动压缩记录。
export function readAutoCompactRules(entries: readonly { type?: string; customType?: string; data?: unknown }[]): AutoCompactRule[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== AUTO_COMPACT_ENTRY) continue;
    const rules = (entry.data as { rules?: unknown } | undefined)?.rules;
    if (!Array.isArray(rules)) return [];
    return rules.flatMap((rule) => {
      const normalized = normalizeRule(rule);
      return normalized ? [normalized] : [];
    });
  }
  return [];
}
