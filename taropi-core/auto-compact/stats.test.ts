import { describe, expect, it } from "vitest";
import type { RegistryEntry } from "./registry.ts";
import { formatAutoCompactHud, formatCompactionTime, formatOfflineStatus, formatSessionLabel, readCompactionStats } from "./stats.ts";
import type { AutoCompactRule } from "./types.ts";

const idle: AutoCompactRule = { id: "idle", enabled: true, type: "idle", value: 1, unit: "h" };
const disabled: AutoCompactRule = { id: "off", enabled: false, type: "every", value: 30, unit: "m" };
const now = new Date(2026, 10, 3, 15, 0, 0).getTime();
const today = new Date(2026, 10, 3, 14, 32, 0).getTime();
const yesterday = new Date(2026, 10, 2, 14, 32, 0).getTime();

describe("压缩统计", () => {
  it("空分支没有次数和时间", () => {
    expect(readCompactionStats([])).toEqual({ count: 0 });
    expect(readCompactionStats([{ type: "message", timestamp: new Date(today).toISOString() }])).toEqual({ count: 0 });
  });

  it("多次压缩取最后一条有效时间，无效时间戳仍计数", () => {
    const stats = readCompactionStats([
      { type: "compaction", timestamp: "not-a-time" },
      { type: "compaction", timestamp: new Date(yesterday).toISOString() },
      { type: "compaction", timestamp: new Date(today).toISOString() },
      { type: "compaction" },
    ]);
    expect(stats.count).toBe(4);
    expect(stats.lastAt).toBe(Date.parse(new Date(today).toISOString()));
  });

  it("当天只显示时分，其他日期显示月日时分", () => {
    expect(formatCompactionTime(today, now)).toBe("14:32");
    expect(formatCompactionTime(yesterday, now)).toBe("11-02 14:32");
    expect(formatCompactionTime(new Date(2025, 0, 2, 8, 5).getTime(), now)).toBe("01-02 08:05");
  });

  it("按策略和压缩记录组合显示", () => {
    expect(formatAutoCompactHud([idle], { count: 3, lastAt: today }, now)).toBe("上次 14:32 · 压缩 3 次 · 闲置 1h");
    expect(formatAutoCompactHud([idle], { count: 0 }, now)).toBe("压缩 0 次 · 闲置 1h");
    expect(formatAutoCompactHud([], { count: 3, lastAt: yesterday }, now)).toBe("上次 11-02 14:32 · 压缩 3 次 · 无策略");
    expect(formatAutoCompactHud([disabled], { count: 0 }, now)).toBe("");
    expect(formatAutoCompactHud([], { count: 2 }, now)).toBe("压缩 2 次 · 无策略");
  });
});

function entry(sessionId: string, nextAt: number | null, extra: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    version: 1,
    sessionId,
    cwd: "/work/a",
    updatedAt: now,
    rules: [{ id: "e", enabled: true, type: "every", value: 30, unit: "m", nextAt }],
    ...extra,
  };
}

describe("离线压缩状态", () => {
  it("没有会话时只说明 cron 状态", () => {
    expect(formatOfflineStatus({ cronInstalled: true, entries: [] }, now)).toBe("离线压缩扫描任务已安装；没有待压缩会话");
    expect(formatOfflineStatus({ cronInstalled: false, entries: [] }, now)).toContain("未安装");
  });

  it("只列未到期会话，显示会话名与时间", () => {
    const text = formatOfflineStatus({
      cronInstalled: true,
      entries: [
        entry("abcdef123456", now + 3_600_000, { name: "PC互动表态兼容" }),
        entry("zzz", now - 1, { name: "已跑完的会话" }),
        entry("pending", null, { name: "没有策略" }),
        entry("later", now + 7_200_000),
      ],
    }, now);
    expect(text.split("\n")[0]).toBe("离线压缩扫描任务已安装；共 2 个会话");
    expect(text).toContain("PC互动表态兼容 · 下次 16:00");
    expect(text).toContain("a · 下次 17:00");
    expect(text).not.toContain("已跑完的会话");
    expect(text).not.toContain("没有策略");
    expect(text).not.toContain("已到期");
  });

  it("会话名缺失时回退目录名，超长截断到 20 字", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十一二三";
    expect(formatSessionLabel(entry("id", now + 1, { name: long }))).toBe(`${long.slice(0, 19)}…`);
    expect(formatSessionLabel(entry("id", now + 1, { cwd: "/work/backend" }))).toBe("backend");
    expect(formatSessionLabel(entry("abcdef123456", now + 1, { cwd: "" }))).toBe("abcdef12");
  });
});
