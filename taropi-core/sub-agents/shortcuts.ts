import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { isPanelActive, navigateTab } from "./agent-panel.ts";

function getNavigationDelta(data: string): number | undefined {
  // parseKey 可安全区分 Ctrl+[ 的 CSI-u / modifyOtherKeys 序列和裸 Escape。
  const parsed = parseKey(data);
  if (parsed === Key.ctrl("[")) return -1;
  if (parsed === Key.ctrl("]")) return 1;

  // parseKey 规范化组合修饰键时会返回 shift+ctrl，而 Key helper 采用 ctrl+shift；
  // 因此回退组合键交给 matchesKey 比较。
  if (matchesKey(data, Key.ctrlShift("["))) return -1;
  if (matchesKey(data, Key.ctrlShift("]"))) return 1;
  return undefined;
}

// installPanelShortcutCompatibility 仅在子 Agent 面板激活时消费导航按键，保留编辑器原有 Ctrl+] 行为。
export function installPanelShortcutCompatibility(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;

  ctx.ui.onTerminalInput((data) => {
    if (!isPanelActive()) return;

    // parseKey 会把传统终端的 ESC 解析为 escape，而不会误认为 Ctrl+[。
    // 因此原始 Ctrl+[ 只有在 Kitty / CSI-u 等可区分修饰键的协议下才会生效。
    const delta = getNavigationDelta(data);
    if (delta === undefined) return;

    navigateTab(delta);
    return { consume: true };
  });
}
