import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HudTheme } from "./theme.ts";

export const HUD_PROTOCOL_VERSION = 1;
export const HUD_EVENTS = {
  hostReady: "taropi:hud:host-ready",
  register: "taropi:hud:register",
  unregister: "taropi:hud:unregister",
  refresh: "taropi:hud:refresh",
  refreshResult: "taropi:hud:refresh-result",
  render: "taropi:hud:render",
} as const;

export type HudRefreshReason = "initial" | "command" | "external";

/** HudRefreshContext HUD 调用子版块刷新时提供的会话信息。 */
export interface HudRefreshContext {
  ctx: ExtensionContext;
  reason: HudRefreshReason;
  signal: AbortSignal;
}

/** HudPanelState HUD 子版块最近一次刷新后的状态。 */
export interface HudPanelState<T = unknown> {
  value: T | undefined;
  status: "idle" | "refreshing" | "ready" | "error";
  error?: string;
  updatedAt?: number;
}

/** HudPanelProvider HUD 子版块必须实现的数据刷新与文本渲染能力。 */
export interface HudPanelProvider<T = unknown> {
  key: string;
  refresh(context: HudRefreshContext): Promise<T> | T;
  render(state: HudPanelState<T>, theme: HudTheme, width: number): string[];
  timeoutMs?: number;
}

export interface HudPanelRegistration {
  key: string;
  provider: HudPanelProvider;
}

export interface HudRefreshRequest {
  key?: string;
  reason: HudRefreshReason;
  requestId?: string;
}

export interface HudRefreshResult {
  requestId: string;
  failedKeys: string[];
}
