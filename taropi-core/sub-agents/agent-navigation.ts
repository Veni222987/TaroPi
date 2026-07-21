import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  getAgentResultByRunId,
  getSelectedAgentResult,
  isMainAgentSelected,
  isPanelActive,
} from "./agent-panel.ts";
import { closeAgentDetailPage, isAgentDetailPageOpen, showAgentDetailPage } from "./agent-detail.ts";
import type { SingleResult } from "./types.ts";

let removeInputListener: (() => void) | null = null;

// installAgentDetailNavigation 监听面板激活期间的 Enter，并按稳定 runId 打开详情页。
export function installAgentDetailNavigation(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || removeInputListener) return;

  removeInputListener = ctx.ui.onTerminalInput((data) => {
    if (!isPanelActive() || isAgentDetailPageOpen() || !matchesKey(data, Key.enter)) return;
    // Main 本身没有详情页；消费 Enter，保证它不会误提交到主编辑器。
    if (isMainAgentSelected()) return { consume: true };

    const selected = getSelectedAgentResult();
    if (!selected) return;
    const runId = selected.runId;
    showAgentDetailPage(ctx, () => getLiveResult(runId, selected));
    return { consume: true };
  });
}

function getLiveResult(runId: string | undefined, fallback: SingleResult): SingleResult | undefined {
  return runId ? getAgentResultByRunId(runId) : getSelectedAgentResult() ?? fallback;
}

// disposeAgentDetailNavigation 移除原始输入监听器，并关闭详情页的刷新定时器。
export function disposeAgentDetailNavigation(): void {
  removeInputListener?.();
  removeInputListener = null;
  closeAgentDetailPage();
}
