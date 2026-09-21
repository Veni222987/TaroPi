import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHudClient, registerHud } from "taropi-hud";
import type { HudClient } from "taropi-hud/api";

let client: HudClient | undefined;

// registerHudFeature 注册 core 使用的 HUD 宿主并初始化内部适配层。
export function registerHudFeature(pi: ExtensionAPI): void {
  const hud = createHudClient(pi);
  client = hud;
  registerHud(pi);
  hud.render();
}

// requestHudRender 请求 HUD 重绘，不执行子版块的数据刷新。
export function requestHudRender(): void {
  client?.render();
}
