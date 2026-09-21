import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HudPanelRegistry } from "./registry.ts";
import type { HudPanelProvider } from "./protocol.ts";

const context = {} as ExtensionContext;
const theme = {} as never;

function provider<T>(key: string, refresh: HudPanelProvider<T>["refresh"], timeoutMs?: number): HudPanelProvider<T> {
  return {
    key,
    refresh,
    timeoutMs,
    render: (state) => (state.value === undefined ? [] : [String(state.value)]),
  };
}

describe("HudPanelRegistry", () => {
  it("并发调度不同版块并保留注册顺序", async () => {
    const registry = new HudPanelRegistry();
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    registry.register(provider("first", first));
    registry.register(provider("second", second));

    await registry.refresh(undefined, context, "command");

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(registry.get().map((panel) => panel.provider.key)).toEqual(["first", "second"]);
    expect(registry.get().map((panel) => panel.provider.render(panel.state, theme, 67))).toEqual([["first"], ["second"]]);
  });

  it("刷新失败时保留上次成功数据并标记异常", async () => {
    const registry = new HudPanelRegistry();
    let value = "ready";
    registry.register(provider("balance", async () => {
      if (value === "fail") throw new Error("余额服务不可用");
      return value;
    }));

    await registry.refresh("balance", context, "initial");
    value = "fail";
    const results = await registry.refresh("balance", context, "external");
    const panel = registry.get("balance")[0]!;

    expect(results[0]?.status).toBe("rejected");
    expect(panel.state).toMatchObject({ value: "ready", status: "error", error: "余额服务不可用" });
  });

  it("同一版块按请求顺序执行，超时后继续处理后续刷新", async () => {
    const registry = new HudPanelRegistry();
    const refresh = vi.fn(async ({ signal }: Parameters<HudPanelProvider<string>["refresh"]>[0]) => {
      await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return "never";
    });
    registry.register(provider("slow", refresh, 5));

    const first = registry.refresh("slow", context, "external");
    const second = registry.refresh("slow", context, "command");
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult[0]?.status).toBe("rejected");
    expect(secondResult[0]?.status).toBe("rejected");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("只在 provider 相同时注销，避免旧句柄删除新注册", () => {
    const registry = new HudPanelRegistry();
    const oldProvider = provider("same", () => "old");
    const newProvider = provider("same", () => "new");
    registry.register(oldProvider);
    registry.register(newProvider);
    registry.unregister("same", oldProvider);

    expect(registry.get("same")[0]?.provider).toBe(newProvider);
  });
});
