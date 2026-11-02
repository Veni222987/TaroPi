// 无依赖的标准 5 段 cron（分 时 日 月 周），支持 *、列表、范围和步长。

interface CronField {
  matches(value: number): boolean;
}

interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  dayOfMonthAny: boolean;
  dayOfWeekAny: boolean;
}

const FIELD_PATTERN = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

// parseCron 解析 cron；非法时返回 undefined。
export function parseCron(expression: string): CronSchedule | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dayOfMonth = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  const dayOfWeek = parseField(fields[4]!, 0, 7, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return undefined;
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthAny: fields[2] === "*",
    dayOfWeekAny: fields[4] === "*",
  };
}

// nextCronTime 返回严格晚于 from 的下一个本地匹配时间（秒归零）。
export function nextCronTime(expression: string, from: Date): Date | undefined {
  const schedule = parseCron(expression);
  if (!schedule) return undefined;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  if (cursor.getTime() <= from.getTime()) cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  for (let time = cursor.getTime(); time <= limit; time += 60_000) {
    const date = new Date(time);
    if (matches(schedule, date)) return date;
  }
  return undefined;
}

// describeCron 给出简短中文含义；无法解析时说明无效。
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (!parseCron(expression) || fields.length !== 5) return "表达式无效";
  const [minute, hour, day, month, week] = fields;
  if (minute !== "*" && hour !== "*" && day === "*" && month === "*" && week === "*" && /^\d+$/.test(minute!) && /^\d+$/.test(hour!)) {
    return `每天 ${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  }
  return `Cron ${expression.trim()}`;
}

function parseField(text: string, min: number, max: number, dayOfWeek = false): CronField | undefined {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const matched = FIELD_PATTERN.exec(part.trim());
    if (!matched) return undefined;
    const step = matched[3] ? Number(matched[3]) : 1;
    if (!Number.isInteger(step) || step <= 0) return undefined;
    const star = matched[1] === "*";
    if (star && matched[2]) return undefined;
    const start = star ? min : Number(matched[1]);
    const end = matched[2] ? Number(matched[2]) : (star || matched[3] ? max : start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(dayOfWeek && value === 7 ? 0 : value);
  }
  if (values.size === 0) return undefined;
  return { matches: (value) => values.has(value) };
}

function matches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.matches(date.getMinutes()) || !schedule.hour.matches(date.getHours()) || !schedule.month.matches(date.getMonth() + 1)) return false;
  const dayMatches = schedule.dayOfMonth.matches(date.getDate());
  const weekMatches = schedule.dayOfWeek.matches(date.getDay());
  if (!schedule.dayOfMonthAny && !schedule.dayOfWeekAny) return dayMatches || weekMatches;
  return dayMatches && weekMatches;
}
