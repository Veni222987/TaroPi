import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHudClient } from "./api.ts";
import { HUD_EVENTS } from "./protocol.ts";

function createPi() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: unknown }> = [];
  return {
    emitted,
    pi: {
      events: {
        emit(channel: string, value: unknown) {
          emitted.push({ channel, value });
          for (const listener of listeners.get(channel) ?? []) listener(value);
        },
        on(channel: string, handler: (value: unknown) => void) {
          const handlers = listeners.get(channel) ?? [];
          handlers.push(handler);
          listeners.set(channel, handlers);
          return () => undefined;
        },
      },
    } as unknown as ExtensionAPI,
  };
}

describe("HUD 客户端", () => {
  it("收到宿主就绪通知后重新公告已有版块", () => {
    const { pi, emitted } = createPi();
    const hud = createHudClient(pi);
    hud.register({ key: "balance", refresh: () => "100", render: () => [] });

    pi.events.emit(HUD_EVENTS.hostReady, { version: 1 });

    expect(emitted.filter((item) => item.channel === HUD_EVENTS.register)).toHaveLength(2);
  });

  it("通过回执等待单版块和全量刷新完成", async () => {
    const { pi, emitted } = createPi();
    pi.events.on(HUD_EVENTS.refresh, (value) => {
      const request = value as { requestId: string };
      pi.events.emit(HUD_EVENTS.refreshResult, { requestId: request.requestId, failedKeys: [] });
    });
    const hud = createHudClient(pi);
    const panel = hud.register({ key: "balance", refresh: () => "100", render: () => [] });

    await panel.refresh();
    await hud.refreshAll();

    expect(emitted.filter((item) => item.channel === HUD_EVENTS.refresh)).toHaveLength(2);
  });

  it("拒绝缺少刷新或渲染能力的版块", () => {
    const { pi } = createPi();
    const hud = createHudClient(pi);

    expect(() => hud.register({ key: "broken", render: () => [] } as never)).toThrow("refresh");
    expect(() => hud.register({ key: "", refresh: () => undefined, render: () => [] })).toThrow("key");
  });
});
