/**
 * HUD 面板注册中心。
 *
 * 其他插件通过 registerHudPanel 向 HUD 注册内容面板，在自身状态变更时
 * 调用 requestHudRefresh 触发 HUD 重渲染，实现 HUD 作为全局看板中心。
 */
import type { HudTheme } from "./theme.ts";

/** HudPanelProvider HUD 面板提供者接口 */
export interface HudPanelProvider {
  /** 唯一标识，同 key 注册会覆盖前一个 */
  key: string;
  /**
   * 渲染面板内容，返回 ANSI 字符串数组（每个元素一行）。
   * 返回空数组表示当前无需显示，HUD 会跳过该面板（含分隔线）。
   */
  render(theme: HudTheme): string[];
}

const providers = new Map<string, HudPanelProvider>();
let refreshCallback: (() => void) | null = null;

/** registerHudPanel 向 HUD 注册一个内容面板 */
export function registerHudPanel(provider: HudPanelProvider): void {
  providers.set(provider.key, provider);
}

/** unregisterHudPanel 移除已注册的面板 */
export function unregisterHudPanel(key: string): void {
  providers.delete(key);
}

/** getHudPanels 返回当前所有已注册面板（按注册顺序） */
export function getHudPanels(): HudPanelProvider[] {
  return Array.from(providers.values());
}

/** setHudRefreshCallback 由 HUD 内部调用，注册刷新回调（仅 HUD 模块使用） */
export function setHudRefreshCallback(fn: () => void): void {
  refreshCallback = fn;
}

/** requestHudRefresh 供插件主动触发 HUD 重渲染 */
export function requestHudRefresh(): void {
  refreshCallback?.();
}
