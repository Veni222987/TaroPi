import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAutoCompact } from "./index.ts";
import { AUTO_COMPACT_ENTRY } from "./types.ts";

vi.mock("./compactor.ts", () => ({ compactUsingCuprum: vi.fn(async () => ({ compaction: { summary: "cu" } })) }));
vi.mock("taropi-hud/api", () => ({
  createHudClient: () => ({ register: vi.fn(), render: vi.fn() }),
}));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function setup() {
  const hooks = new Map<string, Handler>();
  let command: Command | undefined;
  const appendEntry = vi.fn();
  const api = {
    appendEntry,
    registerCommand: vi.fn((_name: string, registered: { handler: Command }) => {
      command = registered.handler;
    }),
    on: vi.fn((event: string, handler: Handler) => {
      hooks.set(event, handler);
    }),
  };
  registerAutoCompact(api as unknown as ExtensionAPI);
  const notify = vi.fn();
  const custom = vi.fn(async (): Promise<unknown> => null);
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { notify, custom },
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: vi.fn(),
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionCommandContext;
  return { hooks, command: command!, appendEntry, notify, custom, ctx };
}

afterEach(() => vi.useRealTimers());

describe("/auto-compact 注册", () => {
  it("打开面板后把编辑结果写入当前会话", async () => {
    const harness = setup();
    harness.custom.mockResolvedValueOnce([{ id: "new", enabled: true, type: "idle", value: 30, unit: "m" }]);
    await harness.command("", harness.ctx);
    expect(harness.appendEntry).toHaveBeenCalledWith(AUTO_COMPACT_ENTRY, {
      rules: [{ id: "new", enabled: true, type: "idle", value: 30, unit: "m" }],
    });
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("已保存"), "info");
  });

  it("恢复已有记录，clear 清空，无界面只显示状态", async () => {
    const harness = setup();
    harness.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: AUTO_COMPACT_ENTRY, data: { rules: [{ id: "old", enabled: true, type: "cron", cron: "0 3 * * *" }] } }] as never;
    await harness.hooks.get("session_start")!({}, harness.ctx);
    await harness.command("status", harness.ctx);
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("cron 0 3 * * *"), "info");
    await harness.command("clear", harness.ctx);
    expect(harness.appendEntry).toHaveBeenLastCalledWith(AUTO_COMPACT_ENTRY, { rules: [] });
    harness.ctx.hasUI = false;
    await harness.command("", harness.ctx);
    expect(harness.custom).not.toHaveBeenCalled();
  });

  it("所有压缩请求都交给铜牌模型，关闭时停止计时", async () => {
    vi.useFakeTimers();
    const { compactUsingCuprum } = await import("./compactor.ts");
    const harness = setup();
    await harness.command("", { ...harness.ctx, mode: "print" } as ExtensionCommandContext);
    const before = harness.hooks.get("session_before_compact")!;
    await before({ signal: new AbortController().signal }, harness.ctx);
    expect(compactUsingCuprum).toHaveBeenCalledOnce();
    harness.hooks.get("session_shutdown")!({}, harness.ctx);
    expect(harness.ctx.compact).not.toHaveBeenCalled();
  });
});
