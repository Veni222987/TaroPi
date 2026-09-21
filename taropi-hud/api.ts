import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HUD_EVENTS,
  HUD_PROTOCOL_VERSION,
  type HudPanelProvider,
  type HudRefreshReason,
  type HudRefreshRequest,
  type HudRefreshResult,
} from "./protocol.ts";

/** HudPanelHandle 已注册 HUD 子版块的控制句柄。 */
export interface HudPanelHandle {
  key: string;
  refresh(reason?: HudRefreshReason): Promise<void>;
  render(): void;
  unregister(): void;
}

/** HudClient 供其他 Pi 扩展注册和调度 HUD 子版块的客户端。 */
export interface HudClient {
  register<T>(provider: HudPanelProvider<T>): HudPanelHandle;
  refreshAll(reason?: HudRefreshReason): Promise<void>;
  render(): void;
}

function validateProvider(provider: HudPanelProvider): void {
  if (!provider || typeof provider.key !== "string" || !provider.key.trim()) {
    throw new Error("HUD 子版块必须提供非空 key。");
  }
  if (typeof provider.refresh !== "function" || typeof provider.render !== "function") {
    throw new Error(`HUD 子版块 ${provider.key} 必须同时实现 refresh 和 render。`);
  }
  if (provider.timeoutMs !== undefined && (!Number.isFinite(provider.timeoutMs) || provider.timeoutMs <= 0)) {
    throw new Error(`HUD 子版块 ${provider.key} 的 timeoutMs 必须是正数。`);
  }
}

function requestId(): string {
  return `hud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// createHudClient 创建与 HUD 宿主通信的客户端；每个扩展实例应在其注册函数内创建一个客户端。
export function createHudClient(pi: ExtensionAPI): HudClient {
  const providers = new Map<string, HudPanelProvider>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  function announce(provider: HudPanelProvider): void {
    pi.events.emit(HUD_EVENTS.register, { version: HUD_PROTOCOL_VERSION, provider });
  }

  function requestRefresh(key: string | undefined, reason: HudRefreshReason): Promise<void> {
    const id = requestId();
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      pi.events.emit(HUD_EVENTS.refresh, { key, reason, requestId: id } satisfies HudRefreshRequest);
    });
  }

  pi.events.on(HUD_EVENTS.hostReady, () => {
    for (const provider of providers.values()) announce(provider);
  });
  pi.events.on(HUD_EVENTS.refreshResult, (value) => {
    const result = value as Partial<HudRefreshResult>;
    if (typeof result.requestId !== "string") return;
    const completion = pending.get(result.requestId);
    if (!completion) return;
    pending.delete(result.requestId);
    if ((result.failedKeys?.length ?? 0) > 0) {
      completion.reject(new Error(`HUD 刷新失败: ${result.failedKeys?.join(", ")}`));
      return;
    }
    completion.resolve();
  });

  return {
    register<T>(provider: HudPanelProvider<T>): HudPanelHandle {
      validateProvider(provider);
      providers.set(provider.key, provider);
      announce(provider);
      let active = true;
      return {
        key: provider.key,
        refresh: async (reason = "external") => {
          if (!active) return;
          await requestRefresh(provider.key, reason);
        },
        render: () => {
          if (active) pi.events.emit(HUD_EVENTS.render, undefined);
        },
        unregister: () => {
          if (!active) return;
          active = false;
          if (providers.get(provider.key) !== provider) return;
          providers.delete(provider.key);
          pi.events.emit(HUD_EVENTS.unregister, { key: provider.key, provider });
        },
      };
    },
    refreshAll: async (reason = "external") => requestRefresh(undefined, reason),
    render: () => pi.events.emit(HUD_EVENTS.render, undefined),
  };
}
