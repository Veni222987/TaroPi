import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatToolCall, getDisplayItems } from "./render.ts";
import type { SingleResult } from "./types.ts";

export const AGENT_PANEL_KEY = "subagent-panel";
const PANEL_MAX_LINES = 15;

interface AgentPanelState {
  results: SingleResult[];
  selectedIndex: number;
  mode: "parallel" | "chain" | null;
  // TUI 实例由 setWidget 工厂回调注入，仅用于触发重绘，不跨模块暴露
  tui: { requestRender(force?: boolean): void } | null;
  theme: Theme | null;
}

// 模块级单例：registerShortcut 在插件加载时注册，handler 需要在任意 execute 调用期间
// 都能访问到当前面板状态，因此用模块变量而非 execute 闭包持有。
const panelState: AgentPanelState = {
  results: [],
  selectedIndex: 0,
  mode: null,
  tui: null,
  theme: null,
};

class AgentPanelComponent {
  invalidate(): void {}
  render(width: number): string[] {
    const { results, selectedIndex, mode, theme } = panelState;
    if (!theme || results.length === 0) return [];
    const w = Math.min(width, 80);
    const hr = theme.fg("muted", "─".repeat(w));
    const lines: string[] = [];

    const running = results.filter((r) => r.exitCode === -1).length;
    const done = results.filter((r) => r.exitCode !== -1).length;
    const total = results.length;
    const statusStr =
      running > 0 ? `${done}/${total} done, ${running} running` : `${done}/${total} done`;
    lines.push(` ${theme.fg("toolTitle", theme.bold(mode ?? ""))}  ${theme.fg("dim", statusStr)}`);
    lines.push(hr);

    const tabs = results.map((r, i) => {
      const icon =
        r.exitCode === -1
          ? theme.fg("warning", "⏳")
          : r.exitCode === 0
            ? theme.fg("toolTitle", "✓")
            : theme.fg("error", "✗");
      const name = r.agent.length > 10 ? r.agent.slice(0, 9) + "…" : r.agent;
      const label = `${name} ${icon}`;
      return i === selectedIndex
        ? ` ${theme.fg("accent", `[${label}]`)} `
        : ` ${theme.fg("dim", label)} `;
    });
    lines.push(tabs.join(""));
    lines.push(hr);

    const selected = results[selectedIndex];
    const contentLines = selected ? buildPanelLines(selected, theme, PANEL_MAX_LINES) : [];
    lines.push(...contentLines);
    // 用空行填满固定高度，防止内容变化时编辑器区域上下抖动
    for (let k = contentLines.length; k < PANEL_MAX_LINES; k++) lines.push("");

    return lines;
  }
}

function buildPanelLines(result: SingleResult, theme: Theme, maxLines: number): string[] {
  if (result.exitCode === -1 && result.messages.length === 0)
    return [theme.fg("dim", "  (starting…)")];
  const items = getDisplayItems(result.messages);
  const out: string[] = [];
  for (const item of items) {
    if (item.type === "toolCall") {
      out.push(
        "  " + theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
      );
    } else {
      for (const line of item.text.split("\n")) out.push("  " + theme.fg("toolOutput", line));
    }
  }
  if (out.length === 0)
    out.push(theme.fg("dim", result.exitCode === -1 ? "  (running…)" : "  (no output)"));
  return out.slice(-maxLines); // 只取最后 N 行，避免内容区溢出
}

export function showAgentPanel(
  ctx: ExtensionContext,
  results: SingleResult[],
  mode: "parallel" | "chain",
): void {
  if (ctx.mode !== "tui") return;
  panelState.results = results;
  panelState.selectedIndex = 0;
  panelState.mode = mode;
  // 组件只创建一次；后续状态变化通过 requestRender() 触发重绘而非重建组件
  ctx.ui.setWidget(AGENT_PANEL_KEY, (tui, theme) => {
    panelState.tui = tui;
    panelState.theme = theme;
    const comp = new AgentPanelComponent();
    return Object.assign(comp, {
      dispose() {
        // widget 被移除后置空，避免 refreshPanel 调用悬空引用
        panelState.tui = null;
        panelState.theme = null;
      },
    });
  });
}

export function refreshPanel(results?: SingleResult[]): void {
  if (results) panelState.results = results;
  panelState.tui?.requestRender();
}

export function refreshPanelWithIndex(results: SingleResult[], selectedIndex: number): void {
  panelState.results = results;
  panelState.selectedIndex = selectedIndex;
  panelState.tui?.requestRender();
}

export function navigateTab(delta: number): boolean {
  if (panelState.results.length === 0) return false;
  const idx = (panelState.selectedIndex + delta + panelState.results.length) % panelState.results.length;
  panelState.selectedIndex = idx;
  panelState.tui?.requestRender();
  return true;
}

export function isPanelActive(): boolean {
  return panelState.mode !== null && panelState.results.length > 0;
}
