import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hudTheme } from "taropi-hud/theme";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAutoCompact } from "./index.ts";
import { AUTO_COMPACT_ENTRY } from "./types.ts";

const hud = vi.hoisted(() => {
  const clients = new Map<unknown, {
    provider?: { render: (state: unknown, theme: unknown, width: number) => string[] };
    render: ReturnType<typeof vi.fn>;
  }>();
  return {
    bind(owner: unknown) {
      const current = { provider: undefined as { render: (state: unknown, theme: unknown, width: number) => string[] } | undefined, render: vi.fn() };
      clients.set(owner, current);
      return {
        register: (provider: { render: (state: unknown, theme: unknown, width: number) => string[] }) => {
          current.provider = provider;
          return { refresh: vi.fn(), render: vi.fn(), unregister: vi.fn() };
        },
        render: () => current.render(),
      };
    },
    of(owner: unknown) {
      return clients.get(owner);
    },
  };
});

vi.mock("./compactor.ts", () => ({ compactUsingCuprum: vi.fn(async () => ({ compaction: { summary: "cu" } })) }));
vi.mock("taropi-hud/api", () => ({
  createHudClient: (owner: unknown) => hud.bind(owner),
}));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function visible(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function hudText(owner: unknown): string {
  const provider = hud.of(owner)?.provider;
  if (!provider) return "";
  return visible(provider.render({ value: undefined, status: "idle" }, hudTheme, 67).join("\n"));
}

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
  const client = hud.of(api);
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
  return { hooks, command: command!, appendEntry, notify, custom, ctx, client, api };
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

  it("HUD 显示策略、上次压缩时间和当前分支次数", async () => {
    const harness = setup();
    const at = new Date();
    harness.ctx.sessionManager.getBranch = () => [
      { type: "custom", customType: AUTO_COMPACT_ENTRY, data: { rules: [{ id: "idle", enabled: true, type: "idle", value: 1, unit: "h" }] } },
      { type: "compaction", timestamp: at.toISOString() },
    ] as never;
    await harness.hooks.get("session_start")!({}, harness.ctx);
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    expect(hudText(harness.api)).toBe(`🗜 auto-compact 上次 ${clock} · 压缩 1 次 · 闲置 1h`);

    const fresh = setup();
    fresh.ctx.sessionManager.getBranch = () => [{ type: "compaction", timestamp: new Date(2020, 10, 2, 14, 32).toISOString() }] as never;
    await fresh.hooks.get("session_start")!({}, fresh.ctx);
    expect(hudText(fresh.api)).toBe("🗜 auto-compact 上次 11-02 14:32 · 压缩 1 次 · 无策略");
  });

  it("切换分支后更新压缩次数，失败的压缩不计数", async () => {
    const harness = setup();
    const initial = [{ type: "compaction", timestamp: new Date().toISOString() }];
    const switched = [
      { type: "compaction", timestamp: new Date(2020, 0, 2, 8, 1).toISOString() },
      { type: "compaction", timestamp: new Date(2020, 0, 2, 9, 2).toISOString() },
    ];
    let branch = initial;
    harness.ctx.sessionManager.getBranch = (() => branch) as never;
    await harness.hooks.get("session_start")!({}, harness.ctx);
    expect(hudText(harness.api)).toContain("无策略");
    expect(hudText(harness.api)).toContain("压缩 1 次");

    await harness.hooks.get("session_compact_failed")!({}, harness.ctx);
    expect(hudText(harness.api)).toContain("压缩 1 次");

    branch = switched;
    await harness.hooks.get("session_tree")!({}, harness.ctx);
    expect(hudText(harness.api)).toBe("🗜 auto-compact 上次 01-02 09:02 · 压缩 2 次 · 无策略");
    expect(harness.client?.render).toHaveBeenCalled();

    branch = [...switched, { type: "compaction", timestamp: new Date(2020, 0, 3, 10, 3).toISOString() }];
    await harness.hooks.get("session_compact")!({}, harness.ctx);
    expect(hudText(harness.api)).toContain("压缩 3 次");
    expect(hudText(harness.api)).toContain("上次 01-03 10:03");
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
