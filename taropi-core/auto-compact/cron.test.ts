import { describe, expect, it } from "vitest";
import { describeCron, nextCronTime, parseCron } from "./cron.ts";

describe("5 段 cron", () => {
  it("解析星号、列表、范围和步长，拒绝非法字段", () => {
    expect(parseCron("0 3 * * *")).toBeDefined();
    expect(parseCron("*/15 0-6 1,15 * 1-5")).toBeDefined();
    expect(parseCron("0 3 * *")).toBeUndefined();
    expect(parseCron("60 * * * *")).toBeUndefined();
    expect(parseCron("* * * * 8")).toBeUndefined();
  });

  it("返回严格晚于当前时间的下一次本地匹配", () => {
    const from = new Date(2026, 10, 2, 3, 0, 30);
    const next = nextCronTime("0 3 * * *", from);
    expect(next).toEqual(new Date(2026, 10, 3, 3, 0, 0));
    expect(nextCronTime("*/15 * * * *", new Date(2026, 10, 2, 3, 14, 0))).toEqual(new Date(2026, 10, 2, 3, 15, 0));
  });

  it("日和周同时指定时按或匹配，周日 7 等同 0", () => {
    const monday = new Date(2026, 10, 2, 3, 0, 0);
    expect(nextCronTime("0 3 1 * 1", monday)).toEqual(new Date(2026, 10, 9, 3, 0, 0));
    expect(nextCronTime("0 0 * * 7", new Date(2026, 10, 1, 1, 0, 0))).toEqual(new Date(2026, 10, 8, 0, 0, 0));
  });

  it("描述每天固定时刻，非法表达式给出无效", () => {
    expect(describeCron("5 3 * * *")).toBe("每天 03:05");
    expect(describeCron("bad")).toBe("表达式无效");
  });
});
