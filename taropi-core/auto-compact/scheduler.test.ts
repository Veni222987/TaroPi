import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCompactRuntime, type AutoCompactHost } from "./scheduler.ts";
import { AUTO_COMPACT_ENTRY, type AutoCompactRule } from "./types.ts";

afterEach(() => {
  vi.useRealTimers();
});

function host(entries: unknown[] = [], busy = false): AutoCompactHost & { compact: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
  return {
    compact: vi.fn(),
    notify: vi.fn(),
    ui: { notify: vi.fn() },
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries as AutoCompactHost["sessionManager"]["getBranch"] extends () => infer R ? R : never },
  } as unknown as AutoCompactHost & { compact: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

const every: AutoCompactRule = { id: "e", enabled: true, type: "every", value: 30, unit: "s" };
const idle: AutoCompactRule = { id: "i", enabled: true, type: "idle", value: 30, unit: "m" };
const cron: AutoCompactRule = { id: "c", enabled: true, type: "cron", cron: "0 3 * * *" };

describe("自动压缩调度", () => {
  it("从最新会话记录恢复，every 到点触发并继续下一轮", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const runtime = new AutoCompactRuntime(persist);
    const ctx = host([{ type: "custom", customType: AUTO_COMPACT_ENTRY, data: { rules: [every] } }, { type: "message" }]);
    runtime.restore(ctx);
    expect(runtime.snapshot()).toEqual([every]);
    vi.advanceTimersByTime(29_999);
    expect(ctx.compact).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    runtime.onCompactFinished(ctx);
    vi.advanceTimersByTime(30_000);
    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it("忙时记下补执行，空闲后只压缩一次", () => {
    vi.useFakeTimers();
    const runtime = new AutoCompactRuntime(vi.fn());
    const ctx = host([], true);
    runtime.save([every], ctx);
    runtime.onBusy(ctx);
    vi.advanceTimersByTime(30_000);
    expect(ctx.compact).not.toHaveBeenCalled();
    ctx.isIdle = () => true;
    runtime.onSettled(ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    runtime.onCompactFinished(ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("idle 需要新活动后才计时，压缩完成后同一空闲周期不重复", () => {
    vi.useFakeTimers();
    const runtime = new AutoCompactRuntime(vi.fn());
    const ctx = host();
    runtime.save([idle], ctx);
    vi.advanceTimersByTime(30 * 60_000);
    expect(ctx.compact).not.toHaveBeenCalled();
    runtime.onActivity(ctx);
    runtime.onSettled(ctx);
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(ctx.compact).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    runtime.onCompactFinished(ctx);
    vi.advanceTimersByTime(30 * 60_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("活动会取消正在计时的 idle，cron 到点且会话过小只静默跳过", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 2, 59, 0));
    const runtime = new AutoCompactRuntime(vi.fn());
    const ctx = host();
    runtime.save([idle], ctx);
    runtime.onActivity(ctx);
    runtime.onSettled(ctx);
    vi.advanceTimersByTime(60_000);
    runtime.onActivity(ctx);
    vi.advanceTimersByTime(30 * 60_000);
    expect(ctx.compact).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 10, 2, 2, 59, 30));
    runtime.save([cron], ctx);
    ctx.compact.mockImplementation((options: { onError?: (error: Error) => void }) => options.onError?.(new Error("Nothing to compact (session too small)")));
    vi.advanceTimersByTime(30_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("停止后不再触发，未恢复前命令读取当前分支", () => {
    vi.useFakeTimers();
    const runtime = new AutoCompactRuntime(vi.fn());
    const ctx = host([{ type: "custom", customType: AUTO_COMPACT_ENTRY, data: { rules: [every] } }]);
    runtime.ensureRestored(ctx);
    expect(runtime.snapshot()).toEqual([every]);
    runtime.stop();
    vi.advanceTimersByTime(30_000);
    expect(ctx.compact).not.toHaveBeenCalled();
  });
});
