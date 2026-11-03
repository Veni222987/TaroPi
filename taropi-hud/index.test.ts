import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUsageSummary, registerHud } from "./index.ts";

vi.mock("node:child_process", () => ({
  execFile: (_file: unknown, _args: unknown, _options: unknown, callback: (error: Error) => void) => {
    callback(new Error("git disabled"));
  },
}));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function visible(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("用量摘要", () => {
  it("在命中率后显示会话时长", () => {
    expect(visible(formatUsageSummary(122_400, 0, 9 * 60_000 + 41_000))).toBe("Σ 122.4k ◎ 0% ✦ 9m 41s");
  });

  it("0 token 仍显示用量", () => {
    expect(visible(formatUsageSummary(0, 0, 0))).toBe("Σ 0 ◎ 0% ✦ 0ms");
  });

  it("没有有效时长时不显示时钟", () => {
    expect(visible(formatUsageSummary(1_500, 12.6))).toBe("Σ 1.5k ◎ 13%");
    expect(visible(formatUsageSummary(1_500, 12.6, Number.NaN))).toBe("Σ 1.5k ◎ 13%");
    expect(visible(formatUsageSummary(1_500_000, 100, -1))).toBe("Σ 1.5M ◎ 100%");
  });
});

describe("HUD 基础行", () => {
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  let runtimeDir = "";
  let widgets: string[][] = [];
  let hooks = new Map<string, Handler>();
  let ctx: ExtensionContext;

  afterEach(async () => {
    await hooks.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function startHud(getContextUsage: () => unknown): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    runtimeDir = mkdtempSync(join(tmpdir(), "taropi-hud-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    widgets = [];
    hooks = new Map();
    ctx = {
      mode: "tui",
      cwd: "/tmp/demo",
      model: { provider: "tencent-intranet", id: "gpt-6.1-sol" },
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setFooter: vi.fn(),
        setWidget: vi.fn((_key: string, content?: string[]) => {
          if (content) widgets.push(content);
        }),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;
    registerHud({
      events: { on: vi.fn(), emit: vi.fn() },
      registerCommand: vi.fn(),
      on: (event: string, handler: Handler) => {
        hooks.set(event, handler);
      },
    } as unknown as ExtensionAPI);
  }

  it("会话开始后不显示 loop，时长紧跟命中率", async () => {
    startHud(() => ({ tokens: 122_400, percent: 12.2, contextWindow: 1_000_000 }));
    vi.setSystemTime(new Date("2026-11-03T12:00:00.000Z"));
    hooks.get("session_start")?.({}, ctx);
    vi.setSystemTime(new Date("2026-11-03T12:09:41.000Z"));

    await vi.waitFor(() => {
      expect(visible(widgets.at(-1)?.join("\n") ?? "")).toContain("Σ 122.4k ◎ 0% ✦ 9m 41s");
    });
    expect(hooks.has("turn_start")).toBe(false);
    expect(visible(widgets.at(-1)?.join("\n") ?? "")).not.toContain("loop");
  });

  it("上下文不可用时不显示用量和时长", async () => {
    startHud(() => {
      throw new Error("unavailable");
    });
    hooks.get("session_start")?.({}, ctx);
    await vi.waitFor(() => expect(widgets.length).toBeGreaterThan(0));
    const text = visible(widgets.at(-1)?.join("\n") ?? "");
    expect(text).not.toContain("Σ");
    expect(text).not.toContain("✦");
    expect(text).not.toContain("loop");
  });
});
